import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PaymentsService } from './payments.service';

const makePrisma = () => ({
  payment: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
  },
  order: { findFirst: jest.fn() },
  laundryOrder: { findFirst: jest.fn() },
  user: { findUnique: jest.fn() },
});

const makeProvider = () => ({
  name: 'test',
  initialize: jest.fn().mockResolvedValue({ authorizationUrl: 'https://pay.test/c', reference: 'ignored' }),
  verify: jest.fn(),
  verifyWebhookSignature: jest.fn().mockReturnValue(true),
  parseWebhook: jest.fn(),
});

function setup() {
  const prisma = makePrisma();
  const provider = makeProvider();
  const events = { emit: jest.fn() };
  const config = { get: jest.fn((k: string) => (k === 'payments.currency' ? 'GHS' : undefined)) };
  const svc = new PaymentsService(prisma as any, events as any, config as any, provider as any);
  return { prisma, provider, events, svc };
}

const pending = { id: 'p1', orderId: 'o1', laundryOrderId: null, amount: '30.00', method: 'MOBILE_MONEY', status: 'PENDING', reference: 'FM-1' };

describe('PaymentsService.initialize', () => {
  it('needs exactly one of orderId / laundryOrderId', async () => {
    const { svc } = setup();
    await expect(svc.initialize('u1', { method: 'CARD' } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.initialize('u1', { orderId: 'a', laundryOrderId: 'b', method: 'CARD' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses to start a payment for someone else's order", async () => {
    const { svc, prisma, provider } = setup();
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(null);

    await expect(svc.initialize('intruder', { orderId: 'o1', method: 'CARD' } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(provider.initialize).not.toHaveBeenCalled();
    // ownership is part of the query itself
    expect(prisma.payment.findFirst.mock.calls[0][0].where.order).toEqual({ customerId: 'intruder' });
  });

  it('rejects an order that is already paid', async () => {
    const { svc, prisma } = setup();
    prisma.payment.findFirst.mockResolvedValue({ ...pending, status: 'SUCCESSFUL' });
    await expect(svc.initialize('u1', { orderId: 'o1', method: 'CARD' } as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('charges the amount stored on the server', async () => {
    const { svc, prisma, provider } = setup();
    prisma.payment.findFirst.mockResolvedValue(pending);
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.c' });

    const out = await svc.initialize('u1', { orderId: 'o1', method: 'CARD' } as any);

    expect(provider.initialize.mock.calls[0][0]).toMatchObject({ amount: 30, currency: 'GHS', email: 'a@b.c', channels: ['card'] });
    expect(out).toMatchObject({ authorizationUrl: 'https://pay.test/c', amount: 30 });
    expect(out.reference).toMatch(/^FM-/);
  });

  it('refuses cash without touching the payment or the provider', async () => {
    const { svc, prisma, provider } = setup();
    prisma.payment.findFirst.mockResolvedValue(pending);

    await expect(svc.initialize('u1', { orderId: 'o1', method: 'CASH' } as any)).rejects.toThrow(
      /no longer available/,
    );
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(provider.initialize).not.toHaveBeenCalled();
  });

  it('lets a payment left as CASH from before the change be paid online', async () => {
    const { svc, prisma, provider } = setup();
    prisma.payment.findFirst.mockResolvedValue({ ...pending, method: 'CASH', reference: null });
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.c' });

    await svc.initialize('u1', { orderId: 'o1', method: 'MOBILE_MONEY' } as any);

    expect(provider.initialize.mock.calls[0][0]).toMatchObject({ channels: ['mobile_money'] });
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ method: 'MOBILE_MONEY', status: 'PENDING' }) }),
    );
  });
});

describe('InitializePaymentDto', () => {
  // Imported lazily so the decorators run against the real class-validator.
  const { validate } = require('class-validator');
  const { plainToInstance } = require('class-transformer');
  const { InitializePaymentDto } = require('./dto/initialize-payment.dto');

  const errorsFor = async (method: unknown) => {
    const errors = await validate(plainToInstance(InitializePaymentDto, { orderId: 'o1', method }));
    return errors.flatMap((e: any) => Object.values(e.constraints ?? {}));
  };

  it('accepts mobile money and card', async () => {
    expect(await errorsFor('MOBILE_MONEY')).toEqual([]);
    expect(await errorsFor('CARD')).toEqual([]);
  });

  it('rejects cash with a clear message, and unknown methods', async () => {
    expect(await errorsFor('CASH')).toEqual([expect.stringMatching(/no longer available/)]);
    expect(await errorsFor('BITCOIN')).toEqual([expect.stringMatching(/MOBILE_MONEY, CARD/)]);
  });
});

describe('PaymentsService settle / verify / webhook', () => {
  it('marks a matching successful payment paid and emits the event once', async () => {
    const { svc, prisma, provider, events } = setup();
    prisma.payment.findFirst.mockResolvedValue(pending);
    provider.verify.mockResolvedValue({ status: 'success', amount: 30, currency: 'GHS', providerReference: '77' });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.findUnique.mockResolvedValue({ ...pending, status: 'SUCCESSFUL' });

    const out = await svc.verify('u1', 'FM-1');

    expect(out.status).toBe('SUCCESSFUL');
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('payment.successful', expect.objectContaining({ orderId: 'o1' }));
  });

  it('does not emit again when another request already settled it', async () => {
    const { svc, prisma, provider, events } = setup();
    prisma.payment.findFirst.mockResolvedValue(pending);
    provider.verify.mockResolvedValue({ status: 'success', amount: 30, currency: 'GHS' });
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });
    prisma.payment.findUnique.mockResolvedValue({ ...pending, status: 'SUCCESSFUL' });

    await svc.verify('u1', 'FM-1');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses to mark paid when the amount does not match the order', async () => {
    const { svc, prisma, provider, events } = setup();
    prisma.payment.findFirst.mockResolvedValue(pending);
    provider.verify.mockResolvedValue({ status: 'success', amount: 1, currency: 'GHS' });

    await expect(svc.verify('u1', 'FM-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses to mark paid when the currency does not match', async () => {
    const { svc, prisma, provider } = setup();
    prisma.payment.findFirst.mockResolvedValue(pending);
    provider.verify.mockResolvedValue({ status: 'success', amount: 30, currency: 'USD' });
    await expect(svc.verify('u1', 'FM-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('marks a failed provider result as FAILED', async () => {
    const { svc, prisma, provider } = setup();
    prisma.payment.findFirst.mockResolvedValue(pending);
    provider.verify.mockResolvedValue({ status: 'failed', amount: 0, currency: 'GHS' });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });

    const out = await svc.verify('u1', 'FM-1');
    expect(out.status).toBe('FAILED');
  });

  it('cannot verify a payment the caller does not own', async () => {
    const { svc, prisma } = setup();
    prisma.payment.findFirst.mockResolvedValue(null);
    await expect(svc.verify('intruder', 'FM-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a webhook with a bad signature', async () => {
    const { svc, provider } = setup();
    provider.verifyWebhookSignature.mockReturnValue(false);
    await expect(svc.handleWebhook(Buffer.from('{}'), 'bad', {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('re-verifies with the provider on a signed charge.success webhook', async () => {
    const { svc, prisma, provider, events } = setup();
    provider.parseWebhook.mockReturnValue({ type: 'charge.success', reference: 'FM-1' });
    prisma.payment.findUnique.mockResolvedValueOnce(pending).mockResolvedValue({ ...pending, status: 'SUCCESSFUL' });
    provider.verify.mockResolvedValue({ status: 'success', amount: 30, currency: 'GHS' });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });

    await expect(svc.handleWebhook(Buffer.from('{}'), 'sig', {})).resolves.toEqual({ received: true });
    expect(provider.verify).toHaveBeenCalledWith('FM-1');
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('acknowledges but ignores events for unknown references', async () => {
    const { svc, prisma, provider } = setup();
    provider.parseWebhook.mockReturnValue({ type: 'charge.success', reference: 'nope' });
    prisma.payment.findUnique.mockResolvedValue(null);
    await expect(svc.handleWebhook(Buffer.from('{}'), 'sig', {})).resolves.toEqual({ received: true });
    expect(provider.verify).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.markCashCollected', () => {
  const cash = { ...pending, method: 'CASH', reference: null };

  it('marks a pending cash payment paid, records who collected it, and emits once', async () => {
    const { svc, prisma, events } = setup();
    prisma.payment.findUnique.mockResolvedValueOnce(cash).mockResolvedValueOnce({ ...cash, status: 'SUCCESSFUL' });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });

    const res = await svc.markCashCollected('p1', 'admin1');

    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', method: 'CASH', status: 'PENDING' },
      data: expect.objectContaining({ status: 'SUCCESSFUL', provider: 'cash', providerRef: 'collected-by:admin1', paidAt: expect.any(Date) }),
    });
    expect(res?.status).toBe('SUCCESSFUL');
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('payment.successful', expect.objectContaining({ id: 'p1' }));
  });

  it('refuses non-cash, already settled, missing, and raced payments', async () => {
    const { svc, prisma, events } = setup();
    prisma.payment.findUnique.mockResolvedValueOnce(pending);
    await expect(svc.markCashCollected('p1', 'a')).rejects.toBeInstanceOf(BadRequestException);

    prisma.payment.findUnique.mockResolvedValueOnce({ ...cash, status: 'SUCCESSFUL' });
    await expect(svc.markCashCollected('p1', 'a')).rejects.toBeInstanceOf(ConflictException);

    prisma.payment.findUnique.mockResolvedValueOnce(null);
    await expect(svc.markCashCollected('nope', 'a')).rejects.toBeInstanceOf(NotFoundException);

    prisma.payment.findUnique.mockResolvedValueOnce(cash);
    prisma.payment.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.markCashCollected('p1', 'a')).rejects.toBeInstanceOf(ConflictException);

    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('PaymentsController.markCashCollected', () => {
  it('is ADMIN only', () => {
    const { Reflector } = require('@nestjs/core');
    const { GUARDS_METADATA } = require('@nestjs/common/constants');
    const { PaymentsController } = require('./payments.controller');
    const { RolesGuard } = require('../../shared/guards/roles.guard');
    const { ROLES_KEY } = require('../../shared/decorators/roles.decorator');
    const handler = PaymentsController.prototype.markCashCollected;
    expect(new Reflector().get(ROLES_KEY, handler)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });
});

describe('PaymentsService.refund', () => {
  const paidOnline = { ...pending, status: 'SUCCESSFUL', method: 'CARD', provider: 'paystack', reference: 'FM-1' };
  const paidCash = { ...pending, status: 'SUCCESSFUL', method: 'CASH', provider: 'cash', reference: null };

  it('claims the payment as refunded before calling the provider', async () => {
    const { svc, prisma, provider } = setup();
    const order: string[] = [];
    (provider as any).refund = jest.fn().mockImplementation(async () => {
      order.push('provider');
      return { refundReference: 'RF1', status: 'pending' };
    });
    prisma.payment.findUnique.mockResolvedValueOnce(paidOnline).mockResolvedValueOnce({ ...paidOnline, status: 'REFUNDED' });
    prisma.payment.updateMany.mockImplementation(async () => {
      order.push('claim');
      return { count: 1 };
    });
    await svc.refund('p1', 'admin1');
    expect(order).toEqual(['claim', 'provider']);
  });

  it('a second refund at the same time is refused without reaching the provider', async () => {
    const { svc, prisma, provider, events } = setup();
    (provider as any).refund = jest.fn();
    prisma.payment.findUnique.mockResolvedValueOnce(paidOnline);
    // The other admin's claim already flipped it.
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.refund('p1', 'admin2')).rejects.toBeInstanceOf(ConflictException);
    expect((provider as any).refund).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refunds online payments through the provider, then marks them refunded', async () => {
    const { svc, prisma, provider, events } = setup();
    (provider as any).refund = jest.fn().mockResolvedValue({ refundReference: 'RF1', status: 'pending' });
    prisma.payment.findUnique.mockResolvedValueOnce(paidOnline).mockResolvedValueOnce({ ...paidOnline, status: 'REFUNDED' });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });

    const res = await svc.refund('p1', 'admin1', 'Wrong item');
    expect((provider as any).refund).toHaveBeenCalledWith('FM-1', 'Wrong item');
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({ where: { id: 'p1', status: 'SUCCESSFUL' }, data: { status: 'REFUNDED' } });
    expect(res).toMatchObject({ status: 'REFUNDED', providerRefund: 'RF1' });
    expect(events.emit).toHaveBeenCalledWith('payment.refunded', expect.objectContaining({ refundedBy: 'admin1', reason: 'Wrong item' }));
  });

  it("marks cash refunded without calling the provider; the payment goes back to SUCCESSFUL if the provider refuses", async () => {
    const { svc, prisma, provider } = setup();
    (provider as any).refund = jest.fn();
    prisma.payment.findUnique.mockResolvedValueOnce(paidCash).mockResolvedValueOnce({ ...paidCash, status: 'REFUNDED' });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    await svc.refund('p1', 'a');
    expect((provider as any).refund).not.toHaveBeenCalled();

    prisma.payment.updateMany.mockClear();
    (provider as any).refund = jest.fn().mockRejectedValue(new Error('provider rejected'));
    prisma.payment.findUnique.mockResolvedValueOnce(paidOnline);
    await expect(svc.refund('p1', 'a')).rejects.toThrow('provider rejected');
    expect(prisma.payment.updateMany).toHaveBeenNthCalledWith(1, { where: { id: 'p1', status: 'SUCCESSFUL' }, data: { status: 'REFUNDED' } });
    expect(prisma.payment.updateMany).toHaveBeenNthCalledWith(2, { where: { id: 'p1', status: 'REFUNDED' }, data: { status: 'SUCCESSFUL' } });
  });

  it('only successful payments can be refunded', async () => {
    const { svc, prisma, events } = setup();
    prisma.payment.findUnique.mockResolvedValueOnce(pending);
    await expect(svc.refund('p1', 'a')).rejects.toBeInstanceOf(ConflictException);
    prisma.payment.findUnique.mockResolvedValueOnce({ ...paidOnline, status: 'REFUNDED' });
    await expect(svc.refund('p1', 'a')).rejects.toBeInstanceOf(ConflictException);
    prisma.payment.findUnique.mockResolvedValueOnce(null);
    await expect(svc.refund('x', 'a')).rejects.toBeInstanceOf(NotFoundException);
    expect(events.emit).not.toHaveBeenCalled();
  });
});
