import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma, StaffRole } from '@prisma/client';
import { Expo } from 'expo-server-sdk';
import { PrismaService } from '../../database/prisma.service';
import { PushService } from './push.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { NotificationsQueryDto } from './dto/notifications-query.dto';
import { afterCursor, toPage } from '../../shared/pagination/cursor';
import { resolvePreferences } from '../logistics/preferences.service';

export interface NotificationUser {
  userId: string;
  role?: string;
}

interface NotifyInput {
  title: string;
  body: string;
  // Machine-readable kind, also sent as data.type in the push so the app can route taps.
  type: string;
  data?: Record<string, string | undefined>;
  channelId?: string;
}

// Android notification channels. These ids must match the channels the app
// creates with Notifications.setNotificationChannelAsync(...).
const NOTIFICATION_LIST_LIMIT = 50;
const BROADCAST_BATCH = 500;

export const BROADCAST_AUDIENCES = ['CUSTOMERS', 'DELIVERY_PARTNER', 'VENDOR', 'LAUNDRY_STAFF', 'ADMIN', 'ALL_STAFF'] as const;
export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];

// Every push goes out on one of these two Android channels. The apps must
// create both with Notifications.setNotificationChannelAsync(id, {
// importance: AndroidImportance.MAX, sound: 'default' }) or Android shows
// them without a popup or sound. A channel id the phone doesn't know is
// dropped by Android, so no other ids are used (broadcasts included).
export const CHANNELS = {
  orders: 'orders',
  deliveries: 'deliveries',
} as const;

// Partner notification switches the backend acts on (see PreferencesService).
type PartnerCategory = 'newJobs' | 'jobUpdates' | 'payments';

type Copy = { title: string; body: string };

// What the customer is told when an order changes status. Specific titles
// read well on a lock screen; the vendor is named when the order has one.
// PENDING is where every order starts ("Order placed" already covers it).
export function orderStatusCopy(status: string, ref: string, vendor?: string | null): Copy | null {
  const who = vendor?.trim() || 'The shop';
  switch (status) {
    case 'CONFIRMED':
      return { title: `${who} accepted your order`, body: `Order ${ref} is confirmed. We'll tell you when it's being prepared.` };
    case 'PREPARING':
      return { title: `${who} is preparing your order`, body: `Order ${ref} is being prepared.` };
    case 'OUT_FOR_DELIVERY':
      return { title: 'Your order is on the way', body: `Order ${ref} is out for delivery.` };
    case 'DELIVERED':
      return { title: 'Order delivered', body: `Order ${ref} has been delivered. Enjoy!` };
    case 'CANCELLED':
      return { title: 'Order cancelled', body: `Order ${ref} was cancelled. If you paid, we'll refund you.` };
    case 'REFUNDED':
      return { title: 'Order refunded', body: `Order ${ref} has been refunded.` };
    default:
      return null;
  }
}

// Laundry moves through ~13 internal steps (tagged, drying, folding, quality
// check…). Customers are only told about the ones they act on or wait for;
// the rest show on the order's tracking timeline without a push.
export function laundryStatusCopy(status: string, ref: string, pickupMode?: string | null): Copy | null {
  switch (status) {
    case 'RECEIVED':
      return { title: "We've got your laundry", body: `Laundry order ${ref} has arrived. We'll tell you when washing starts.` };
    case 'WASHING':
      return { title: 'Your laundry is being washed', body: `Laundry order ${ref} is in the wash.` };
    case 'READY_FOR_DELIVERY':
      return pickupMode?.toLowerCase() === 'dropoff'
        ? { title: 'Your laundry is ready', body: `Laundry order ${ref} is clean and packed, ready for you to collect.` }
        : { title: 'Your laundry is ready', body: `Laundry order ${ref} is clean and packed. We'll bring it to you soon.` };
    case 'OUT_FOR_DELIVERY':
      return { title: 'Your laundry is on the way', body: `Laundry order ${ref} is out for delivery.` };
    case 'COMPLETED':
      return { title: 'Laundry order complete', body: `Laundry order ${ref} is done. Thanks for using Fastermall!` };
    default:
      return null;
  }
}

// A payment confirmed this soon after the order was placed is the same
// moment as "Order placed", so it is stored in the list but not pushed.
const PAYMENT_PUSH_QUIET_MS = 2 * 60 * 1000;

const DELIVERY_STATUS_COPY: Record<string, { title: string; body: string }> = {
  EN_ROUTE_TO_PICKUP: {
    title: 'Delivery partner assigned',
    body: 'A delivery partner is on the way to pick up your order.',
  },
  PICKED_UP: { title: 'Order picked up', body: 'Your order has been picked up.' },
  EN_ROUTE_TO_CUSTOMER: { title: 'Your order is on the way', body: 'Your delivery partner is heading to you.' },
  DELIVERED: { title: 'Order delivered', body: 'Your order has been delivered. Enjoy!' },
};

const shortRef = (id: string) => `#${id.slice(0, 8).toUpperCase()}`;

// Drops undefined values so the push/DB payload is plain JSON.
const cleanData = (data: Record<string, string | undefined> = {}) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Record<string, string>;

// Retention: read notifications go after 90 days, anything after a year. The
// list is a recent-activity feed (orders keep their own history), so this
// only stops the table growing forever.
export const READ_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  onModuleInit() {
    this.cleanupTimer = setInterval(() => void this.cleanupOld(), CLEANUP_EVERY_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /** Deletes read notifications older than 90 days and any older than a year. Never throws. */
  async cleanupOld(now: Date = new Date()): Promise<number> {
    try {
      const { count } = await this.prisma.notification.deleteMany({
        where: {
          OR: [
            { isRead: true, createdAt: { lt: new Date(now.getTime() - READ_RETENTION_MS) } },
            { createdAt: { lt: new Date(now.getTime() - MAX_RETENTION_MS) } },
          ],
        },
      });
      if (count > 0) this.logger.log(`Removed ${count} old notifications`);
      return count;
    } catch (error) {
      this.logger.error(`Notification cleanup failed: ${(error as Error).message}`);
      return 0;
    }
  }

  // ───────── Domain Event Bus listeners ─────────
  // Notifications never gets called directly by Orders/Payments/Laundry/Logistics;
  // it just reacts to events they publish.

  @OnEvent('order.created')
  async onOrderCreated(order: { customerId: string; id: string }) {
    await this.notifyCustomer(order.customerId, {
      title: 'Order placed',
      body: `Your order ${shortRef(order.id)} has been received.`,
      type: 'ORDER_CREATED',
      data: { orderId: order.id },
      channelId: CHANNELS.orders,
    });
  }

  @OnEvent('order.status.updated')
  async onOrderStatusUpdated(order: { customerId: string; id: string; status: string; vendorName?: string | null }) {
    const copy = orderStatusCopy(order.status, shortRef(order.id), order.vendorName);
    if (!copy) return;
    await this.notifyCustomer(order.customerId, {
      ...copy,
      type: 'ORDER_STATUS_UPDATED',
      data: { orderId: order.id, status: order.status },
      channelId: CHANNELS.orders,
    });
  }

  @OnEvent('payment.refunded')
  async onPaymentRefunded(payment: { orderId?: string | null; laundryOrderId?: string | null; method?: string }) {
    let customerId: string | undefined;
    if (payment.orderId) {
      customerId = (await this.prisma.order.findUnique({ where: { id: payment.orderId } }))?.customerId;
    } else if (payment.laundryOrderId) {
      customerId = (await this.prisma.laundryOrder.findUnique({ where: { id: payment.laundryOrderId } }))?.customerId;
    }
    if (!customerId) return;
    await this.notifyCustomer(customerId, {
      title: 'Refund issued',
      body:
        payment.method === 'CASH'
          ? 'Your cash payment has been refunded.'
          : 'Your payment has been refunded. It can take a few days to reach your account.',
      type: 'PAYMENT_REFUNDED',
      data: { orderId: payment.orderId ?? undefined, laundryOrderId: payment.laundryOrderId ?? undefined },
      channelId: CHANNELS.orders,
    });
  }

  @OnEvent('laundry.created')
  async onLaundryCreated(order: { customerId: string; id: string }) {
    await this.notifyCustomer(order.customerId, {
      title: 'Laundry pickup requested',
      body: `Your laundry order ${shortRef(order.id)} has been received.`,
      type: 'LAUNDRY_CREATED',
      data: { laundryOrderId: order.id },
      channelId: CHANNELS.orders,
    });
  }

  @OnEvent('laundry.status.updated')
  async onLaundryStatusUpdated(order: { customerId: string; id: string; status: string; pickupMode?: string | null }) {
    const copy = laundryStatusCopy(order.status, shortRef(order.id), order.pickupMode);
    if (!copy) return; // an internal step: shown on the tracking timeline only
    await this.notifyCustomer(order.customerId, {
      ...copy,
      type: 'LAUNDRY_STATUS_UPDATED',
      data: { laundryOrderId: order.id, status: order.status },
      channelId: CHANNELS.orders,
    });
  }

  @OnEvent('payment.successful')
  async onPaymentSuccessful(payment: { orderId?: string; laundryOrderId?: string }) {
    // Payment doesn't carry customerId directly — look it up via the order
    let customerId: string | undefined;
    let placedAt: Date | undefined;
    if (payment.orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: payment.orderId } });
      customerId = order?.customerId;
      placedAt = order?.createdAt;
    } else if (payment.laundryOrderId) {
      const order = await this.prisma.laundryOrder.findUnique({ where: { id: payment.laundryOrderId } });
      customerId = order?.customerId;
      placedAt = order?.createdAt;
    }
    if (customerId) {
      // Paid by card at checkout: "Order placed" was pushed seconds ago, so
      // this one only goes in the list. A payment confirmed later (cash
      // collected at the door, a slow MoMo approval) is still pushed.
      const justPlaced = !!placedAt && Date.now() - placedAt.getTime() < PAYMENT_PUSH_QUIET_MS;
      await this.notifyCustomer(
        customerId,
        {
          title: 'Payment successful',
          body: 'Your payment has been confirmed.',
          type: 'PAYMENT_SUCCESSFUL',
          data: { orderId: payment.orderId, laundryOrderId: payment.laundryOrderId },
          channelId: CHANNELS.orders,
        },
        { push: !justPlaced },
      );
    }
  }

  // Emitted by Logistics whenever a delivery partner moves a delivery forward.
  @OnEvent('delivery.status.updated')
  async onDeliveryStatusUpdated(event: {
    deliveryId: string;
    status: string;
    customerId: string;
    orderId?: string;
    laundryOrderId?: string;
  }) {
    const copy = DELIVERY_STATUS_COPY[event.status];
    if (!copy) return; // e.g. FAILED / ASSIGNED — nothing to tell the customer
    await this.notifyCustomer(event.customerId, {
      ...copy,
      type: 'DELIVERY_STATUS_UPDATED',
      data: {
        deliveryId: event.deliveryId,
        orderId: event.orderId,
        laundryOrderId: event.laundryOrderId,
        status: event.status,
      },
      // Customers: "orders" (their app has no "deliveries" channel).
      channelId: CHANNELS.orders,
    });
  }

  // Emitted by Orders/Logistics when a new unclaimed delivery appears.
  @OnEvent('delivery.created')
  async onDeliveryCreated(event: { deliveryId: string; orderId?: string; laundryOrderId?: string }) {
    // Delivery partners only handle food deliveries; marketplace and laundry
    // deliveries are handled by admins, so partners are never alerted to them.
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: event.deliveryId },
      select: { order: { select: { type: true } } },
    });
    if (delivery?.order?.type !== 'FOOD') return;

    // Only partners who are online AND whose account is still active.
    const partners = await this.prisma.deliveryPartnerProfile.findMany({
      where: { isAvailable: true, staffUser: { isActive: true } },
      select: { staffUserId: true, preferences: true },
    });
    if (partners.length === 0) return;

    const input: NotifyInput = {
      title: 'New delivery available',
      body: 'A new delivery is waiting to be claimed.',
      type: 'DELIVERY_AVAILABLE',
      // jobId is the same id as deliveryId; the partner app opens the job with it.
      data: {
        deliveryId: event.deliveryId,
        jobId: event.deliveryId,
        orderId: event.orderId,
        laundryOrderId: event.laundryOrderId,
      },
      channelId: CHANNELS.deliveries,
    };
    const staffUserIds = partners.map((p) => p.staffUserId);

    // Everyone gets the in-app notification...
    await this.safely(() =>
      this.prisma.notification.createMany({
        data: staffUserIds.map((staffUserId) => ({
          staffUserId,
          title: input.title,
          body: input.body,
          type: input.type,
          data: cleanData(input.data) as Prisma.InputJsonValue,
        })),
      }),
    );

    // ...but the push respects each partner's own settings.
    const loud: string[] = [];
    const quiet: string[] = [];
    for (const p of partners) {
      const { notifications } = resolvePreferences(p.preferences);
      if (notifications.newJobs === false) continue;
      (notifications.sound === false ? quiet : loud).push(p.staffUserId);
    }
    const payload = {
      title: input.title,
      body: input.body,
      channelId: input.channelId,
      data: { type: input.type, ...cleanData(input.data) },
    };
    if (loud.length) void this.push.sendToOwners({ staffUserIds: loud }, payload);
    if (quiet.length) void this.push.sendToOwners({ staffUserIds: quiet }, { ...payload, sound: false });
  }

  // Emitted by Logistics when a partner claims a delivery. Every other
  // partner's "New delivery available" for it now points at a job that is
  // gone, so those alerts are removed (the claimer has the job itself).
  @OnEvent('delivery.claimed')
  async onDeliveryClaimed(event: { deliveryId: string; staffUserId: string }) {
    await this.safely(() =>
      this.prisma.notification.deleteMany({
        where: {
          type: 'DELIVERY_AVAILABLE',
          staffUserId: { not: null },
          data: { path: ['deliveryId'], equals: event.deliveryId },
        },
      }),
    );
  }

  // Emitted when an admin approves or rejects a partner's document.
  @OnEvent('partner.document.reviewed')
  async onPartnerDocumentReviewed(event: {
    staffUserId: string;
    documentId: string;
    documentLabel: string;
    status: 'APPROVED' | 'REJECTED';
    reason?: string;
  }) {
    const approved = event.status === 'APPROVED';
    await this.notifyPartner(event.staffUserId, {
      title: approved ? 'Document approved' : 'Document rejected',
      body: approved
        ? `Your ${event.documentLabel.toLowerCase()} was approved.`
        : `Your ${event.documentLabel.toLowerCase()} was rejected: ${event.reason ?? 'please upload a clearer copy'}`,
      type: 'DOCUMENT_REVIEWED',
      data: { documentId: event.documentId, status: event.status },
      channelId: CHANNELS.deliveries,
    });
  }

  // Emitted by Support when an admin answers a ticket. The ticket belongs to
  // a customer (userId) or a staff member such as a partner (staffUserId).
  @OnEvent('support.reply.created')
  async onSupportReply(event: { ticketId: string; userId?: string; staffUserId?: string; subject: string }) {
    const input: NotifyInput = {
      title: 'Support replied',
      body: `We replied to your ticket "${event.subject.slice(0, 60)}".`,
      type: 'SUPPORT_REPLY',
      data: { ticketId: event.ticketId },
      channelId: CHANNELS.orders,
    };
    if (event.staffUserId) await this.notifyPartner(event.staffUserId, input);
    else if (event.userId) await this.notifyCustomer(event.userId, input);
  }

  // A customer cancelled a paid order and the automatic refund was refused.
  // Every admin is told so someone refunds it by hand.
  @OnEvent('order.refund.failed')
  async onOrderRefundFailed(event: { orderId: string; paymentId: string; amount: string }) {
    await this.safely(() =>
      this.broadcast(
        'ADMIN',
        'Refund needed',
        `Order ${shortRef(event.orderId)} was cancelled by the customer but the automatic refund of GH₵ ${Number(event.amount).toFixed(2)} failed. Refund it in Payments.`,
        { type: 'REFUND_NEEDED', data: { orderId: event.orderId, paymentId: event.paymentId } },
      ),
    );
  }

  // ───────── Pre-orders ─────────

  // New request: every admin is told so someone quotes it.
  @OnEvent('preorder.submitted')
  async onPreOrderSubmitted(event: { requestId: string }) {
    await this.safely(() =>
      this.broadcast('ADMIN', 'New pre-order request', `Request ${shortRef(event.requestId)} is waiting for a quote.`, {
        type: 'PREORDER_SUBMITTED',
        data: { preOrderId: event.requestId },
      }),
    );
  }

  @OnEvent('preorder.quoted')
  async onPreOrderQuoted(event: { requestId: string; customerId: string; price: number; estimatedDate: string }) {
    const date = new Date(event.estimatedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Accra' });
    await this.notifyCustomer(event.customerId, {
      title: 'Your pre-order quote is ready',
      body: `GH₵ ${event.price.toFixed(2)}, ready around ${date}. Open it to accept or decline.`,
      type: 'PREORDER_QUOTED',
      data: { preOrderId: event.requestId },
      channelId: CHANNELS.orders,
    });
  }

  @OnEvent('preorder.status.updated')
  async onPreOrderStatusUpdated(event: { requestId: string; customerId: string; status: string; note?: string }) {
    const done = event.status === 'FULFILLED';
    await this.notifyCustomer(event.customerId, {
      title: done ? 'Your pre-order is ready' : 'Pre-order cancelled',
      body: done
        ? `Pre-order ${shortRef(event.requestId)} is complete.${event.note ? ` ${event.note}` : ''}`
        : `Pre-order ${shortRef(event.requestId)} was cancelled.${event.note ? ` ${event.note}` : ''}`,
      type: done ? 'PREORDER_FULFILLED' : 'PREORDER_CANCELLED',
      data: { preOrderId: event.requestId },
      channelId: CHANNELS.orders,
    });
  }

  // The customer accepted, declined or cancelled: admins need to know.
  @OnEvent('preorder.customer.decided')
  async onPreOrderDecided(event: { requestId: string; status: string }) {
    const verb = event.status === 'ACCEPTED' ? 'accepted' : event.status === 'DECLINED' ? 'declined' : 'cancelled';
    await this.safely(() =>
      this.broadcast('ADMIN', `Pre-order ${verb}`, `The customer ${verb} pre-order ${shortRef(event.requestId)}.`, {
        type: `PREORDER_${event.status}`,
        data: { preOrderId: event.requestId },
      }),
    );
  }

  // Emitted by Orders when the customer moves a marketplace delivery.
  @OnEvent('order.delivery.rescheduled')
  async onDeliveryRescheduled(event: {
    orderId: string;
    customerId: string;
    claimedByStaffId?: string;
    to: { start: string; label: string };
  }) {
    const data = { orderId: event.orderId, windowStart: event.to.start };
    await this.notifyCustomer(event.customerId, {
      title: 'Delivery rescheduled',
      body: `Your order ${shortRef(event.orderId)} will now be delivered ${event.to.label}.`,
      type: 'DELIVERY_RESCHEDULED',
      data,
      channelId: CHANNELS.orders,
    });
    // The admin who accepted the delivery needs to know the new time.
    if (event.claimedByStaffId) {
      await this.notifyPartner(event.claimedByStaffId, {
        title: 'Delivery rescheduled',
        body: `Order ${shortRef(event.orderId)} moved to ${event.to.label}.`,
        type: 'DELIVERY_RESCHEDULED',
        data,
        channelId: CHANNELS.deliveries,
      });
    }
  }

  // Emitted by Orders when a cancelled order takes down a delivery a partner
  // had accepted, so they stop heading to the vendor.
  @OnEvent('delivery.cancelled')
  async onDeliveryCancelled(event: { deliveryId: string; orderId?: string; staffUserId: string }) {
    await this.notifyPartner(
      event.staffUserId,
      {
        title: 'Delivery cancelled',
        body: 'An order you accepted was cancelled. You do not need to deliver it.',
        type: 'DELIVERY_CANCELLED',
        data: { deliveryId: event.deliveryId, jobId: event.deliveryId, orderId: event.orderId },
        channelId: CHANNELS.deliveries,
      },
      'jobUpdates',
    );
  }

  // Emitted by the wallet when an admin marks a cash-out paid or failed.
  @OnEvent('partner.cashout.updated')
  async onCashOutUpdated(event: {
    staffUserId: string;
    payoutId: string;
    status: 'PAID' | 'FAILED';
    amountPesewas: number;
    reason?: string | null;
  }) {
    const amount = `GHS ${(event.amountPesewas / 100).toFixed(2)}`;
    await this.notifyPartner(
      event.staffUserId,
      event.status === 'PAID'
        ? {
            title: 'Cash-out sent',
            body: `Your cash-out of ${amount} has been sent.`,
            type: 'CASHOUT_PAID',
            data: { payoutId: event.payoutId, status: event.status },
            channelId: CHANNELS.deliveries,
          }
        : {
            title: 'Cash-out failed',
            body: `Your cash-out of ${amount} could not be sent${event.reason ? `: ${event.reason}` : ''}. The money is back in your balance.`,
            type: 'CASHOUT_FAILED',
            data: { payoutId: event.payoutId, status: event.status },
            channelId: CHANNELS.deliveries,
          },
      'payments',
    );
  }

  // Emitted by Admin when money sent to a partner by hand is recorded.
  @OnEvent('partner.payout.recorded')
  async onPayoutRecorded(event: { staffUserId: string; payoutId: string; amount: string }) {
    await this.notifyPartner(
      event.staffUserId,
      {
        title: 'Payment sent',
        body: `GHS ${Number(event.amount).toFixed(2)} has been paid to you.`,
        type: 'PAYOUT_RECORDED',
        data: { payoutId: event.payoutId },
        channelId: CHANNELS.deliveries,
      },
      'payments',
    );
  }

  // ───────── Test pushes (diagnosing a missing popup or sound) ─────────

  /**
   * Sends a test push to every phone of one account and returns what Expo
   * said for each, plus the device's switches. Nothing is added to the
   * in-app list. Category switches are ignored so the test always goes out.
   */
  async sendTestPush(target: NotificationUser) {
    const staff = this.isStaff(target);
    const channelId = staff ? CHANNELS.deliveries : CHANNELS.orders;
    const { devices, results } = await this.push.sendTest(
      staff ? { staffUserIds: [target.userId] } : { userIds: [target.userId] },
      {
        title: 'Test notification',
        body: 'If you can see and hear this, notifications are working.',
        channelId,
        data: { type: 'TEST' },
      },
    );

    return {
      channelId,
      devices: devices.map((d, i) => ({ ...d, result: results.find((r) => r.token === d.token) ?? results[i] ?? null })),
      sent: results.filter((r) => r.status === 'ok').length,
      failed: results.filter((r) => r.status === 'error').length,
      hint:
        devices.length === 0
          ? 'No phone is registered for this account. The app must call POST /notifications/devices after login.'
          : results.some((r) => r.status === 'ok')
            ? `Expo accepted the push. If the phone shows nothing, or no popup or sound: the app must create the "${channelId}" channel with MAX importance and sound, and set Notifications.setNotificationHandler so banners and sound play while the app is open.`
            : 'Expo refused the push. See each device result (DeviceNotRegistered = the app must register again; InvalidCredentials = the FCM/APNs keys in the Expo project).',
    };
  }

  /** Admin: the same test for someone else's account (404 if unknown). */
  async sendTestPushTo(target: { userId?: string; staffUserId?: string }) {
    if (!!target.userId === !!target.staffUserId) {
      throw new BadRequestException('Send exactly one of userId or staffUserId');
    }
    if (target.userId) {
      const user = await this.prisma.user.findFirst({ where: { id: target.userId, deletedAt: null }, select: { id: true } });
      if (!user) throw new NotFoundException('Customer not found');
      return this.sendTestPush({ userId: user.id, role: 'CUSTOMER' });
    }
    const staff = await this.prisma.staffUser.findUnique({ where: { id: target.staffUserId }, select: { id: true, role: true } });
    if (!staff) throw new NotFoundException('Staff account not found');
    return this.sendTestPush({ userId: staff.id, role: staff.role });
  }

  // ───────── Reading ─────────

  // No paging options: the latest 50, newest first, as before (older ones
  // stay in the database). With `limit`/`cursor`: a page, { items,
  // nextCursor }, newest first.
  async findMine(user: NotificationUser, query: NotificationsQueryDto = {}) {
    const paged = !!(query.limit || query.cursor);
    const rows = await this.prisma.notification.findMany({
      where: {
        ...this.ownerWhere(user),
        ...(query.unread ? { isRead: false } : {}),
        ...(query.cursor ? afterCursor(query.cursor, 'desc') : {}),
      },
      take: paged ? (query.limit ?? 20) + 1 : NOTIFICATION_LIST_LIMIT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return paged ? toPage(rows, query.limit ?? 20) : rows;
  }

  async unreadCount(user: NotificationUser) {
    const count = await this.prisma.notification.count({
      where: { ...this.ownerWhere(user), isRead: false },
    });
    return { unread: count };
  }

  // Only the owner can change a notification. Someone else's id answers
  // "not found", so ids can't be probed.
  async setRead(id: string, user: NotificationUser, isRead: boolean) {
    const result = await this.prisma.notification.updateMany({
      where: { id, ...this.ownerWhere(user) },
      data: { isRead },
    });
    if (result.count === 0) throw new NotFoundException('Notification not found');
    return this.prisma.notification.findUnique({ where: { id } });
  }

  markRead(id: string, user: NotificationUser) {
    return this.setRead(id, user, true);
  }

  // Answers { count } (customer app) and { updated } (partner app): the same number.
  async markAllRead(user: NotificationUser) {
    const result = await this.prisma.notification.updateMany({
      where: { ...this.ownerWhere(user), isRead: false },
      data: { isRead: true },
    });
    return { count: result.count, updated: result.count };
  }

  async remove(id: string, user: NotificationUser) {
    const result = await this.prisma.notification.deleteMany({
      where: { id, ...this.ownerWhere(user) },
    });
    if (result.count === 0) throw new NotFoundException('Notification not found');
    return { removed: true };
  }

  // ───────── Devices (Expo push tokens) ─────────

  async registerDevice(user: NotificationUser, dto: RegisterDeviceDto) {
    if (!Expo.isExpoPushToken(dto.token)) {
      throw new BadRequestException('Invalid Expo push token');
    }
    const owner = this.isStaff(user)
      ? { userId: null, staffUserId: user.userId }
      : { userId: user.userId, staffUserId: null };

    // Token rotated: drop the old one, but only if it was this account's.
    if (dto.previousToken && dto.previousToken !== dto.token) {
      await this.prisma.device.deleteMany({
        where: { token: dto.previousToken, ...this.ownerWhere(user) },
      });
    }

    // The token is unique: if another account used this phone before, the
    // token moves to the account that is logged in now.
    const preferences = {
      ...(dto.preferences?.orderUpdates !== undefined
        ? { orderUpdates: dto.preferences.orderUpdates }
        : {}),
      ...(dto.preferences?.announcements !== undefined
        ? { announcements: dto.preferences.announcements }
        : {}),
    };
    const device = await this.prisma.device.upsert({
      where: { token: dto.token },
      create: { token: dto.token, platform: dto.platform ?? 'unknown', ...owner, ...preferences },
      update: {
        ...(dto.platform ? { platform: dto.platform } : {}),
        ...owner,
        ...preferences,
        lastSeenAt: new Date(),
      },
    });
    return {
      id: device.id,
      token: device.token,
      platform: device.platform,
      preferences: {
        orderUpdates: device.orderUpdates,
        announcements: device.announcements,
      },
    };
  }

  async removeDevice(user: NotificationUser, token: string) {
    const result = await this.prisma.device.deleteMany({
      where: { token, ...this.ownerWhere(user) },
    });
    return { removed: result.count };
  }

  /**
   * Admin broadcast: stores an in-app notification for everyone in the
   * audience and pushes it to their devices (devices with announcements
   * switched off are skipped for the push only). Deactivated staff are left
   * out. Returns how many people it reached in the app.
   */
  async broadcast(
    audience: BroadcastAudience,
    title: string,
    body: string,
    // Optional: a different type (e.g. PROMOTION) and data the app routes taps with.
    extra: { type?: string; data?: Record<string, string> } = {},
  ) {
    const type = extra.type ?? 'ANNOUNCEMENT';
    const t = title.trim();
    const b = body.trim();
    if (!t || !b) throw new BadRequestException('Title and message are required');

    const customers = audience === 'CUSTOMERS';
    const ids = customers
      ? (await this.prisma.user.findMany({ where: { deletedAt: null }, select: { id: true } })).map((u) => u.id)
      : (
          await this.prisma.staffUser.findMany({
            where: { isActive: true, ...(audience === 'ALL_STAFF' ? {} : { role: audience as StaffRole }) },
            select: { id: true },
          })
        ).map((s) => s.id);

    for (let i = 0; i < ids.length; i += BROADCAST_BATCH) {
      const batch = ids.slice(i, i + BROADCAST_BATCH);
      await this.prisma.notification.createMany({
        data: batch.map((id) => ({
          ...(customers ? { userId: id } : { staffUserId: id }),
          title: t,
          body: b,
          type,
          ...(extra.data ? { data: extra.data } : {}),
        })),
      });
      void this.push.sendToOwners(customers ? { userIds: batch } : { staffUserIds: batch }, {
        title: t,
        body: b,
        data: { type, ...(extra.data ?? {}) },
        // Before: no channel, so Android used Expo's fallback channel, which
        // shows no popup. Now the same channel as every other push for that
        // app (customers: orders, staff: deliveries). The "announcements"
        // switch on the device still decides whether the push is sent.
        channelId: customers ? CHANNELS.orders : CHANNELS.deliveries,
        filterAs: 'offers',
      });
    }
    return { audience, recipients: ids.length };
  }

  // ───────── Internals ─────────

  private isStaff(user: NotificationUser) {
    return Object.values(StaffRole).includes(user.role as StaffRole);
  }

  private ownerWhere(user: NotificationUser) {
    return this.isStaff(user) ? { staffUserId: user.userId } : { userId: user.userId };
  }

  // Stores the in-app notification, then sends the push. Neither step is
  // allowed to throw into the event bus.
  private async notifyCustomer(userId: string, input: NotifyInput, opts: { push?: boolean } = {}) {
    await this.safely(() =>
      this.prisma.notification.create({
        data: {
          userId,
          title: input.title,
          body: input.body,
          type: input.type,
          data: cleanData(input.data) as Prisma.InputJsonValue,
        },
      }),
    );
    // The customer app only creates the "orders" channel (plus "offers" for its
    // own local notices). A push on any other channel id, such as
    // "deliveries", lands in Android's fallback channel with no popup or
    // sound, so every customer push goes out on "orders" whatever the caller
    // asked for.
    if (opts.push === false) return;
    void this.push.sendToOwners(
      { userIds: [userId] },
      { title: input.title, body: input.body, channelId: CHANNELS.orders, data: { type: input.type, ...cleanData(input.data) } },
    );
  }

  /**
   * Like notifyStaff, but honours a delivery partner's own settings
   * (GET/PUT /logistics/me/preferences): the in-app notification is always
   * stored; the push is skipped when the partner switched that category off,
   * and is silent when they turned sound off. Staff without a partner
   * profile (admins) get a normal push.
   */
  private async notifyPartner(staffUserId: string, input: NotifyInput, category?: PartnerCategory) {
    const profile = await this.safely(() =>
      this.prisma.deliveryPartnerProfile.findUnique({ where: { staffUserId }, select: { preferences: true } }),
    );
    const prefs = resolvePreferences(profile?.preferences).notifications;
    const pushAllowed = !category || !profile || prefs[category] !== false;

    await this.safely(() =>
      this.prisma.notification.create({
        data: {
          staffUserId,
          title: input.title,
          body: input.body,
          type: input.type,
          data: cleanData(input.data) as Prisma.InputJsonValue,
        },
      }),
    );
    if (!pushAllowed) return;
    void this.push.sendToOwners(
      { staffUserIds: [staffUserId] },
      {
        title: input.title,
        body: input.body,
        channelId: input.channelId,
        data: { type: input.type, ...cleanData(input.data) },
        ...(profile && prefs.sound === false ? { sound: false } : {}),
      },
    );
  }

  private async safely<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      this.logger.error(`Notification write failed: ${(error as Error).message}`);
      return undefined;
    }
  }
}
