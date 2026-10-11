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

  it('keeps cash payments pending without calling the provider', async () => {
    const { svc, prisma, provider } = setup();
    prisma.payment.findFirst.mockResolvedValue(pending);

    const out = await svc.initialize('u1', { orderId: 'o1', method: 'CASH' } as any);

    expect(out).toMatchObject({ method: 'CASH', status: 'PENDING' });
    expect(provider.initialize).not.toHaveBeenCalled();
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
