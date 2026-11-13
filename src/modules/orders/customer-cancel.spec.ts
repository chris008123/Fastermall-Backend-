import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';

// Customer cancels their own order (POST /orders/:id/cancel).
function setup(order: Record<string, unknown> | null, opts: { flipped?: number; refundFails?: boolean } = {}) {
  const tx = {
    order: { updateMany: jest.fn().mockResolvedValue({ count: opts.flipped ?? 1 }) },
    delivery: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    product: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    order: {
      findFirst: jest.fn().mockResolvedValue(order),
      findUnique: jest.fn().mockResolvedValue(order ? { ...order, status: 'CANCELLED' } : null),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const events = { emit: jest.fn() };
  const payments = {
    refund: opts.refundFails ? jest.fn().mockRejectedValue(new Error('Paystack refused')) : jest.fn().mockResolvedValue({}),
  };
  const svc = new OrdersService(prisma, {} as any, {} as any, events as any, { get: jest.fn() } as any, {} as any, undefined, payments as any);
  return { svc, prisma, tx, events, payments };
}

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  customerId: 'u1',
  type: 'MARKETPLACE',
  status: 'PENDING',
  items: [{ productId: 'p1', quantity: 2 }],
  payment: null,
  ...over,
});

describe('OrdersService.cancelByCustomer', () => {
  it('cancels an unpaid order, puts stock back and tells the app', async () => {
    const { svc, tx, events, payments } = setup(order());
    await expect(svc.cancelByCustomer('o1', 'u1')).resolves.toEqual({ id: 'o1', status: 'CANCELLED', refund: 'NOT_PAID' });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['PENDING', 'CONFIRMED'] } },
      data: { status: 'CANCELLED' },
    });
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { increment: 2 } } });
    expect(events.emit).toHaveBeenCalledWith('order.status.updated', expect.objectContaining({ status: 'CANCELLED' }));
    expect(payments.refund).not.toHaveBeenCalled();
  });

  it('refunds an order paid online automatically', async () => {
    const { svc, payments } = setup(order({ status: 'CONFIRMED', payment: { id: 'pay1', status: 'SUCCESSFUL' } }));
    await expect(svc.cancelByCustomer('o1', 'u1')).resolves.toMatchObject({ refund: 'REFUNDED' });
    expect(payments.refund).toHaveBeenCalledWith('pay1', 'customer:u1', 'Cancelled by the customer');
  });

  it('still cancels when the refund fails, and tells the admins', async () => {
    const { svc, events } = setup(order({ payment: { id: 'pay1', status: 'SUCCESSFUL', amount: 45 } }), { refundFails: true });
    await expect(svc.cancelByCustomer('o1', 'u1')).resolves.toMatchObject({ status: 'CANCELLED', refund: 'PENDING_ADMIN' });
    expect(events.emit).toHaveBeenCalledWith('order.refund.failed', {
      orderId: 'o1',
      paymentId: 'pay1',
      amount: '45',
      reason: 'Paystack refused',
    });
  });

  it('does not raise a refund alert when the refund works', async () => {
    const { svc, events } = setup(order({ status: 'CONFIRMED', payment: { id: 'pay1', status: 'SUCCESSFUL', amount: 45 } }));
    await svc.cancelByCustomer('o1', 'u1');
    expect(events.emit).not.toHaveBeenCalledWith('order.refund.failed', expect.anything());
  });

  it('refuses once the order is being prepared, and someone else’s order', async () => {
    await expect(setup(order({ status: 'PREPARING' })).svc.cancelByCustomer('o1', 'u1')).rejects.toMatchObject({
      response: { code: 'ORDER_NOT_CANCELLABLE' },
    });
    // findFirst is scoped to the customer, so another customer's order is "not found".
    await expect(setup(null).svc.cancelByCustomer('o1', 'u2')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses if the order moved on at the same moment', async () => {
    const { svc, payments } = setup(order({ payment: { id: 'pay1', status: 'SUCCESSFUL' } }), { flipped: 0 });
    await expect(svc.cancelByCustomer('o1', 'u1')).rejects.toBeInstanceOf(ConflictException);
    expect(payments.refund).not.toHaveBeenCalled();
  });
});
