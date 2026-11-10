import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { PrismaService } from '../../database/prisma.service';

export interface PushPayload {
  title: string;
  body: string;
  // Delivered to the app as notification.request.content.data
  data?: Record<string, unknown>;
  // Android notification channel. Must match a channel the app creates.
  channelId?: string;
  // Which per-device switch to honour when it differs from the channel
  // (e.g. broadcasts use the default channel but respect "announcements").
  filterAs?: string;
  // false = silent push (the partner turned notification sound off).
  sound?: boolean;
}

/** What Expo said about one device (token masked). */
export interface PushResult {
  token: string;
  status: 'ok' | 'error';
  // Expo's error code, e.g. DeviceNotRegistered, InvalidCredentials, MessageTooBig.
  error?: string;
  message?: string;
}

// Enough of a token to tell devices apart, never the whole thing.
export const maskToken = (token: string) =>
  token.length > 22 ? `${token.slice(0, 18)}…${token.slice(-4)}` : token;

export interface PushTargets {
  userIds?: string[];
  staffUserIds?: string[];
}

// Skips devices whose owner switched this category off in the app.
// Order and delivery progress count as "order updates"; offers and
// announcements as "announcements". Anything else always goes out.
function categoryFilter(channelId?: string) {
  switch (channelId) {
    case 'orders':
    case 'deliveries':
      return { orderUpdates: true };
    case 'offers':
      return { announcements: true };
    default:
      return {};
  }
}

// Expo asks that receipts are fetched ~15 minutes after sending.
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/**
 * Sends push notifications through Expo's push service.
 *
 * Pushes are best-effort: this class never throws, so a push problem can
 * never break the request or event that triggered it. The in-app
 * notification list (the database) is the source of truth.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo: Expo;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    // EXPO_ACCESS_TOKEN is optional; it is only needed if "enhanced push
    // security" is enabled for the project in the Expo dashboard.
    this.expo = new Expo({
      accessToken: config.get<string>('EXPO_ACCESS_TOKEN') || undefined,
    });
  }

  async sendToOwners(targets: PushTargets, payload: PushPayload): Promise<void> {
    try {
      const or: Array<{ userId?: { in: string[] }; staffUserId?: { in: string[] } }> = [];
      if (targets.userIds?.length) or.push({ userId: { in: targets.userIds } });
      if (targets.staffUserIds?.length) or.push({ staffUserId: { in: targets.staffUserIds } });
      if (or.length === 0) return;

      const devices = await this.prisma.device.findMany({
        where: { OR: or, ...categoryFilter(payload.filterAs ?? payload.channelId) },
        select: { token: true },
      });
      await this.send(
        devices.map((d) => d.token),
        payload,
      );
    } catch (error) {
      this.logger.error(`Push failed: ${(error as Error).message}`);
    }
  }

  /**
   * Diagnostic send (POST /notifications/test): pushes to every device of the
   * owners, ignoring the category switches, and returns what Expo answered
   * for each one. Like the normal send it never throws and removes dead
   * tokens. Delivery problems Apple/Google report later only show in the
   * receipts (logged about 15 minutes after).
   */
  async sendTest(targets: PushTargets, payload: PushPayload) {
    const or: Array<{ userId?: { in: string[] }; staffUserId?: { in: string[] } }> = [];
    if (targets.userIds?.length) or.push({ userId: { in: targets.userIds } });
    if (targets.staffUserIds?.length) or.push({ staffUserId: { in: targets.staffUserIds } });
    if (or.length === 0) return { devices: [], results: [] as PushResult[] };

    const devices = await this.prisma.device.findMany({
      where: { OR: or },
      select: { token: true, platform: true, lastSeenAt: true, orderUpdates: true, announcements: true },
      orderBy: { lastSeenAt: 'desc' },
    });
    let results: PushResult[] = [];
    try {
      results = await this.send(devices.map((d) => d.token), payload);
    } catch (error) {
      this.logger.error(`Test push failed: ${(error as Error).message}`);
    }
    return {
      devices: devices.map((d) => ({ ...d, token: maskToken(d.token) })),
      results,
    };
  }

  private async send(tokens: string[], payload: PushPayload): Promise<PushResult[]> {
    const results: PushResult[] = [];
    const messages: ExpoPushMessage[] = [];
    const invalid: string[] = [];

    for (const token of new Set(tokens)) {
      if (!Expo.isExpoPushToken(token)) {
        invalid.push(token);
        results.push({ token: maskToken(token), status: 'error', error: 'InvalidToken', message: 'Not an Expo push token' });
        continue;
      }
      messages.push({
        to: token,
        sound: payload.sound === false ? null : 'default',
        priority: 'high',
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        channelId: payload.channelId,
      });
    }

    if (invalid.length > 0) await this.removeTokens(invalid);
    if (messages.length === 0) return results;

    const dead: string[] = [];
    const receiptIds = new Map<string, string>(); // receipt id -> token

    for (const chunk of this.expo.chunkPushNotifications(messages)) {
      try {
        const tickets = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.forEach((ticket, index) => {
          const token = chunk[index].to as string;
          if (ticket.status === 'ok') {
            receiptIds.set(ticket.id, token);
            results.push({ token: maskToken(token), status: 'ok' });
            return;
          }
          const error = ticket.details?.error;
          results.push({ token: maskToken(token), status: 'error', error, message: ticket.message });
          if (error === 'DeviceNotRegistered') {
            dead.push(token);
          } else {
            this.logger.warn(`Push rejected for ${maskToken(token)}: ${error ?? ''} ${ticket.message}`);
          }
        });
      } catch (error) {
        const message = (error as Error).message;
        this.logger.error(`Expo push request failed: ${message}`);
        for (const m of chunk) {
          results.push({ token: maskToken(m.to as string), status: 'error', error: 'ExpoUnreachable', message });
        }
      }
    }

    if (dead.length > 0) await this.removeTokens(dead);

    if (receiptIds.size > 0) {
      const timer = setTimeout(() => void this.checkReceipts(receiptIds), RECEIPT_DELAY_MS);
      timer.unref(); // never keep the process alive just for this
    }
    return results;
  }

  // Receipts are where Expo reports tokens that Apple/Google no longer accept.
  private async checkReceipts(receiptIds: Map<string, string>): Promise<void> {
    try {
      const dead: string[] = [];
      for (const chunk of this.expo.chunkPushNotificationReceiptIds([...receiptIds.keys()])) {
        const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
        for (const [id, receipt] of Object.entries(receipts)) {
          if (receipt.status !== 'error') continue;
          if (receipt.details?.error === 'DeviceNotRegistered') {
            const token = receiptIds.get(id);
            if (token) dead.push(token);
          } else {
            this.logger.warn(`Push delivery error for ${maskToken(receiptIds.get(id) ?? '')}: ${receipt.details?.error ?? ''} ${receipt.message}`);
          }
        }
      }
      if (dead.length > 0) await this.removeTokens(dead);
    } catch (error) {
      this.logger.error(`Receipt check failed: ${(error as Error).message}`);
    }
  }

  private async removeTokens(tokens: string[]): Promise<void> {
    try {
      await this.prisma.device.deleteMany({ where: { token: { in: tokens } } });
    } catch (error) {
      this.logger.error(`Could not remove stale tokens: ${(error as Error).message}`);
    }
  }
}
