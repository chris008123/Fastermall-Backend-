import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { InitializePaymentDto } from './dto/initialize-payment.dto';
import {
  PAYMENT_PROVIDER,
  PaymentChannel,
  PaymentProvider,
} from './providers/payment-provider.interface';

type PaymentRow = {
  id: string;
  orderId: string | null;
  laundryOrderId: string | null;
  amount: any;
  method: string;
  status: string;
  reference: string | null;
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('PaymentsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  // A PENDING payment record is created the moment an order or laundry order
  // exists, before the customer has paid. The amount always comes from the
  // order total stored on the server, never from the client.
  @OnEvent('order.created')
  async handleOrderCreated(order: { id: string; totalAmount: any }) {
    await this.prisma.payment.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, amount: order.totalAmount, method: 'MOBILE_MONEY', status: 'PENDING' },
      update: {},
    });
  }

  @OnEvent('laundry.created')
  async handleLaundryCreated(order: { id: string; totalAmount: any }) {
    await this.prisma.payment.upsert({
      where: { laundryOrderId: order.id },
      create: { laundryOrderId: order.id, amount: order.totalAmount, method: 'MOBILE_MONEY', status: 'PENDING' },
      update: {},
    });
  }

  /**
   * Starts a payment for one of the caller's own orders.
   * - CASH: the payment stays PENDING (collected on delivery).
   * - CARD / MOBILE_MONEY: returns a hosted checkout URL from the provider.
   */
  async initialize(userId: string, dto: InitializePaymentDto) {
    if (!!dto.orderId === !!dto.laundryOrderId) {
      throw new BadRequestException('Provide exactly one of orderId or laundryOrderId');
    }

    const payment = await this.findOwnedPayment(userId, dto);

    if (payment.status === 'SUCCESSFUL') {
      throw new ConflictException('This order has already been paid');
    }

    const amount = Number(payment.amount);

    if (dto.method === 'CASH') {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { method: 'CASH', status: 'PENDING', reference: null, provider: null },
      });
      return { method: 'CASH', status: 'PENDING', amount };
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.email) throw new BadRequestException('Your account needs an email address to pay online');

    const currency = this.config.get<string>('payments.currency') ?? 'GHS';
    const channels: PaymentChannel[] = [dto.method === 'CARD' ? 'card' : 'mobile_money'];
    const reference = `FM-${randomUUID()}`;

    const init = await this.provider.initialize({
      reference,
      amount,
      currency,
      email: user.email,
      callbackUrl: this.config.get<string>('payments.callbackUrl'),
      channels,
      metadata: { paymentId: payment.id, orderId: dto.orderId, laundryOrderId: dto.laundryOrderId },
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { reference, provider: this.provider.name, method: dto.method, status: 'PENDING' },
    });

    return {
      authorizationUrl: init.authorizationUrl,
      reference,
      amount,
      currency,
      provider: this.provider.name,
    };
  }

  /** Asks the provider for the real outcome of a payment the caller owns. */
  async verify(userId: string, reference: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        reference,
        OR: [{ order: { customerId: userId } }, { laundryOrder: { customerId: userId } }],
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    return this.settle(payment);
  }

  /**
   * Provider webhook. The signature is checked first; the outcome is then
   * re-confirmed with the provider's API rather than trusting the body.
   */
  async handleWebhook(rawBody: Buffer | string | undefined, signature: string | undefined, body: any) {
    if (!this.provider.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = this.provider.parseWebhook(body);
    if (!event?.reference || event.type !== 'charge.success') {
      return { received: true };
    }

    const payment = await this.prisma.payment.findUnique({ where: { reference: event.reference } });
    if (!payment) {
      this.logger.warn(`Webhook for unknown reference ${event.reference}`);
      return { received: true };
    }

    try {
      await this.settle(payment);
    } catch (e) {
      // Always answer 200 so the provider doesn't retry a payment we have
      // already judged (e.g. an amount mismatch). The error is logged.
      this.logger.error(`Webhook settle failed for ${event.reference}: ${(e as Error).message}`);
    }
    return { received: true };
  }

  findMyPayments(customerId: string) {
    return this.prisma.payment.findMany({
      where: {
        OR: [{ order: { customerId } }, { laundryOrder: { customerId } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── internals ──────────────────────────────────────────────────────

  private async findOwnedPayment(userId: string, dto: InitializePaymentDto): Promise<PaymentRow> {
    const existing = await this.prisma.payment.findFirst({
      where: dto.orderId
        ? { orderId: dto.orderId, order: { customerId: userId } }
        : { laundryOrderId: dto.laundryOrderId, laundryOrder: { customerId: userId } },
    });
    if (existing) return existing;

    // The payment row is normally created by the order.created event. If the
    // customer was quick enough to beat it, create it from the stored order.
    if (dto.orderId) {
      const order = await this.prisma.order.findFirst({ where: { id: dto.orderId, customerId: userId } });
      if (!order) throw new NotFoundException('Order not found');
      return this.prisma.payment.upsert({
        where: { orderId: order.id },
        create: { orderId: order.id, amount: order.totalAmount, method: 'MOBILE_MONEY', status: 'PENDING' },
        update: {},
      });
    }

    const laundry = await this.prisma.laundryOrder.findFirst({
      where: { id: dto.laundryOrderId, customerId: userId },
    });
    if (!laundry) throw new NotFoundException('Laundry order not found');
    return this.prisma.payment.upsert({
      where: { laundryOrderId: laundry.id },
      create: { laundryOrderId: laundry.id, amount: laundry.totalAmount, method: 'MOBILE_MONEY', status: 'PENDING' },
      update: {},
    });
  }

  private async settle(payment: PaymentRow) {
    if (payment.status === 'SUCCESSFUL' || !payment.reference) return payment;

    const result = await this.provider.verify(payment.reference);

    if (result.status === 'pending') return payment;

    if (result.status === 'failed') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
      return { ...payment, status: 'FAILED' };
    }

    const expectedCurrency = this.config.get<string>('payments.currency') ?? 'GHS';
    const amountOk = Math.abs(result.amount - Number(payment.amount)) < 0.005;
    if (!amountOk || result.currency !== expectedCurrency) {
      this.logger.error(
        `Payment ${payment.id} amount/currency mismatch: paid ${result.amount} ${result.currency}, expected ${Number(payment.amount)} ${expectedCurrency}`,
      );
      throw new BadRequestException('The amount paid does not match the order total. Please contact support.');
    }

    // Only the first caller to flip PENDING/FAILED -> SUCCESSFUL emits the
    // event, so a webhook and a manual verify can't double-trigger delivery.
    const flipped = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: { not: 'SUCCESSFUL' } },
      data: { status: 'SUCCESSFUL', paidAt: new Date(), providerRef: result.providerReference ?? payment.reference },
    });

    const fresh = await this.prisma.payment.findUnique({ where: { id: payment.id } });
    if (flipped.count === 1 && fresh) {
      this.events.emit('payment.successful', fresh);
    }
    return fresh ?? payment;
  }
}
