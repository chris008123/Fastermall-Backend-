import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { PayDto } from './dto/pay.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // Domain Event Bus listeners — a PENDING payment record is created the moment
  // an order or laundry order exists, before the customer has even paid.
  @OnEvent('order.created')
  async handleOrderCreated(order: { id: string; totalAmount: any }) {
    await this.prisma.payment.create({
      data: {
        orderId: order.id,
        amount: order.totalAmount,
        method: 'MOBILE_MONEY',
        status: 'PENDING',
      },
    });
  }

  @OnEvent('laundry.created')
  async handleLaundryCreated(order: { id: string; totalAmount: any }) {
    await this.prisma.payment.create({
      data: {
        laundryOrderId: order.id,
        amount: order.totalAmount,
        method: 'MOBILE_MONEY',
        status: 'PENDING',
      },
    });
  }

  // Mock payment confirmation. Swap the internals of this method for a real
  // mobile money / card provider integration later — nothing outside this
  // service needs to change since it still just flips status + emits the event.
  async pay(dto: PayDto) {
    if (!dto.orderId && !dto.laundryOrderId) {
      throw new BadRequestException('Provide either orderId or laundryOrderId');
    }

    const payment = await this.prisma.payment.findFirst({
      where: dto.orderId ? { orderId: dto.orderId } : { laundryOrderId: dto.laundryOrderId },
    });
    if (!payment) throw new NotFoundException('No pending payment found for this order');

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCESSFUL', method: dto.method, providerRef: `MOCK-${Date.now()}` },
    });

    this.events.emit('payment.successful', updated);
    return updated;
  }

  findMyPayments(customerId: string) {
    return this.prisma.payment.findMany({
      where: {
        OR: [{ order: { customerId } }, { laundryOrder: { customerId } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
