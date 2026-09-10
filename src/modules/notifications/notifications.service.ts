import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  // Domain Event Bus listeners — Notifications never gets called directly by
  // Orders/Payments/Laundry; it just reacts to events they publish.
  @OnEvent('order.created')
  async onOrderCreated(order: { customerId: string; id: string }) {
    await this.create(order.customerId, 'Order placed', `Your order ${order.id} has been received.`);
  }

  @OnEvent('laundry.created')
  async onLaundryCreated(order: { customerId: string; id: string }) {
    await this.create(order.customerId, 'Laundry pickup requested', `Your laundry order ${order.id} has been received.`);
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
      await this.create(customerId, 'Payment successful', 'Your payment has been confirmed.');
    }
  }

  @OnEvent('laundry.status.updated')
  async onLaundryStatusUpdated(order: { customerId: string; status: string }) {
    await this.create(order.customerId, 'Laundry update', `Your laundry order is now: ${order.status}.`);
  }

  private create(userId: string, title: string, body: string) {
    return this.prisma.notification.create({ data: { userId, title, body } });
  }

  findMine(userId: string) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async markRead(id: string) {
    return this.prisma.notification.update({ where: { id }, data: { isRead: true } });
  }
}
