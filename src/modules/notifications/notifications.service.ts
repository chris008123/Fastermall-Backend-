import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma, StaffRole } from '@prisma/client';
import { Expo } from 'expo-server-sdk';
import { PrismaService } from '../../database/prisma.service';
import { PushService } from './push.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

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
const CHANNELS = {
  orders: 'orders',
  deliveries: 'deliveries',
} as const;

const ORDER_STATUS_COPY: Record<string, string> = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PREPARING: 'being prepared',
  OUT_FOR_DELIVERY: 'out for delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
};

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

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

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
  async onOrderStatusUpdated(order: { customerId: string; id: string; status: string }) {
    const label = ORDER_STATUS_COPY[order.status] ?? order.status.toLowerCase().replace(/_/g, ' ');
    await this.notifyCustomer(order.customerId, {
      title: 'Order update',
      body: `Your order ${shortRef(order.id)} is now ${label}.`,
      type: 'ORDER_STATUS_UPDATED',
      data: { orderId: order.id, status: order.status },
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
  async onLaundryStatusUpdated(order: { customerId: string; id: string; status: string }) {
    await this.notifyCustomer(order.customerId, {
      title: 'Laundry update',
      body: `Your laundry order is now: ${order.status.toLowerCase().replace(/_/g, ' ')}.`,
      type: 'LAUNDRY_STATUS_UPDATED',
      data: { laundryOrderId: order.id, status: order.status },
      channelId: CHANNELS.orders,
    });
  }

  @OnEvent('payment.successful')
  async onPaymentSuccessful(payment: { orderId?: string; laundryOrderId?: string }) {
    // Payment doesn't carry customerId directly — look it up via the order
    let customerId: string | undefined;
    if (payment.orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: payment.orderId } });
      customerId = order?.customerId;
    } else if (payment.laundryOrderId) {
      const order = await this.prisma.laundryOrder.findUnique({ where: { id: payment.laundryOrderId } });
      customerId = order?.customerId;
    }
    if (customerId) {
      await this.notifyCustomer(customerId, {
        title: 'Payment successful',
        body: 'Your payment has been confirmed.',
        type: 'PAYMENT_SUCCESSFUL',
        data: { orderId: payment.orderId, laundryOrderId: payment.laundryOrderId },
        channelId: CHANNELS.orders,
      });
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
      channelId: CHANNELS.deliveries,
    });
  }

  // Emitted by Orders/Logistics when a new unclaimed delivery appears.
  @OnEvent('delivery.created')
  async onDeliveryCreated(event: { deliveryId: string; orderId?: string; laundryOrderId?: string }) {
    const partners = await this.prisma.deliveryPartnerProfile.findMany({
      where: { isAvailable: true },
      select: { staffUserId: true },
    });
    if (partners.length === 0) return;

    const input: NotifyInput = {
      title: 'New delivery available',
      body: 'A new delivery is waiting to be claimed.',
      type: 'DELIVERY_AVAILABLE',
      data: { deliveryId: event.deliveryId, orderId: event.orderId, laundryOrderId: event.laundryOrderId },
      channelId: CHANNELS.deliveries,
    };
    const staffUserIds = partners.map((p) => p.staffUserId);

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
    void this.push.sendToOwners(
      { staffUserIds },
      { title: input.title, body: input.body, channelId: input.channelId, data: { type: input.type, ...cleanData(input.data) } },
    );
  }

  // ───────── Reading ─────────

  findMine(user: NotificationUser) {
    return this.prisma.notification.findMany({
      where: this.ownerWhere(user),
      orderBy: { createdAt: 'desc' },
    });
  }

  // Only the owner can mark a notification read. Someone else's id answers
  // "not found", so ids can't be probed.
  async markRead(id: string, user: NotificationUser) {
    const result = await this.prisma.notification.updateMany({
      where: { id, ...this.ownerWhere(user) },
      data: { isRead: true },
    });
    if (result.count === 0) throw new NotFoundException('Notification not found');
    return this.prisma.notification.findUnique({ where: { id } });
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
    const device = await this.prisma.device.upsert({
      where: { token: dto.token },
      create: { token: dto.token, platform: dto.platform ?? 'unknown', ...owner },
      update: { ...(dto.platform ? { platform: dto.platform } : {}), ...owner, lastSeenAt: new Date() },
    });
    return { id: device.id, token: device.token, platform: device.platform };
  }

  async removeDevice(user: NotificationUser, token: string) {
    const result = await this.prisma.device.deleteMany({
      where: { token, ...this.ownerWhere(user) },
    });
    return { removed: result.count };
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
  private async notifyCustomer(userId: string, input: NotifyInput) {
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
    void this.push.sendToOwners(
      { userIds: [userId] },
      { title: input.title, body: input.body, channelId: input.channelId, data: { type: input.type, ...cleanData(input.data) } },
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
