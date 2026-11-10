import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { UpdateLocationDto } from './dto/update-location.dto';

// Fields cleared when a partner goes offline: nothing about where they are
// is kept once they stop working.
export const CLEARED_LOCATION = {
  currentLat: null,
  currentLng: null,
  locationAt: null,
  locationAccuracyM: null,
} as const;

// Any request from the app counts as "still here", but is written at most
// this often.
const TOUCH_EVERY_MS = 30 * 1000;

/**
 * Who is online and when they were last seen.
 *
 * - No position is stored: live location was removed (Nov 2026). The
 *   location columns are only ever cleared.
 * - The app's normal 30-second job refresh already counts as a heartbeat, so
 *   an open app stays "seen" without any app change.
 * - With PARTNER_AUTO_OFFLINE=true, partners not heard from for
 *   PARTNER_OFFLINE_AFTER_SECONDS (default 180) are set offline, so nobody
 *   whose phone died keeps being offered jobs. Off by default; see config.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get autoOffline() {
    return this.config.get<boolean>('presence.autoOffline') ?? false;
  }
  private get offlineAfterSeconds() {
    return this.config.get<number>('presence.offlineAfterSeconds') ?? 180;
  }
  private get updateEverySeconds() {
    return this.config.get<number>('presence.updateEverySeconds') ?? 60;
  }

  onModuleInit() {
    if (!this.autoOffline) return;
    this.timer = setInterval(() => void this.sweep(), 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** "Still here", from any request. Never throws, never slows the request. */
  async touch(userId: string) {
    try {
      await this.prisma.deliveryPartnerProfile.updateMany({
        where: {
          staffUserId: userId,
          OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(Date.now() - TOUCH_EVERY_MS) } }],
        },
        data: { lastSeenAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(`Could not record presence: ${(error as Error).message}`);
    }
  }

  private async profileFor(userId: string) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({
      where: { staffUserId: userId },
      select: { id: true, isAvailable: true },
    });
    if (!profile) throw new NotFoundException('You are not registered as a delivery partner');
    return profile;
  }

  async heartbeat(userId: string) {
    const profile = await this.profileFor(userId);
    const now = new Date();
    await this.prisma.deliveryPartnerProfile.update({
      where: { id: profile.id },
      data: { lastSeenAt: now },
    });
    return { isAvailable: profile.isAvailable, serverTime: now, nextUpdateInSeconds: this.updateEverySeconds };
  }

  /**
   * PUT /logistics/me/location. Live location was removed (Nov 2026): the
   * coordinates are ignored and nothing about where the partner is gets
   * stored. The call still counts as "still here" (like the heartbeat), so
   * app versions that send it keep the partner online. Offline partners
   * still get 409, as before.
   */
  async updateLocation(userId: string, _dto?: UpdateLocationDto) {
    const profile = await this.profileFor(userId);

    if (!profile.isAvailable) {
      throw new ConflictException({
        message: 'Go online before sending your location',
        code: 'PARTNER_OFFLINE',
      });
    }

    const now = new Date();
    await this.prisma.deliveryPartnerProfile.update({
      where: { id: profile.id },
      // Also wipes any position stored before the feature was removed.
      data: { lastSeenAt: now, ...CLEARED_LOCATION },
    });

    return { receivedAt: now, nextUpdateInSeconds: this.updateEverySeconds, locationStored: false };
  }

  /** Takes quiet partners offline (only when auto-offline is switched on). */
  async sweep() {
    if (!this.autoOffline) return { offlined: 0 };
    try {
      const cutoff = new Date(Date.now() - this.offlineAfterSeconds * 1000);
      const result = await this.prisma.deliveryPartnerProfile.updateMany({
        where: {
          isAvailable: true,
          OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
        },
        data: { isAvailable: false, ...CLEARED_LOCATION },
      });
      if (result.count > 0) this.logger.log(`Set ${result.count} quiet partner(s) offline`);
      return { offlined: result.count };
    } catch (error) {
      this.logger.error(`Offline sweep failed: ${(error as Error).message}`);
      return { offlined: 0 };
    }
  }
}
