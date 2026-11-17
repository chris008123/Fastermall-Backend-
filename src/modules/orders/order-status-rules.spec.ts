import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { allowedOrderStatuses, checkOrderStatusChange } from './order-status-rules';
import { OrdersService } from './orders.service';

// PATCH /orders/:id/status (admin): forward only, cancel until delivered,
// never "refunded" by hand, closed orders stay closed.
describe('order status rules', () => {
  const S = OrderStatus;

  it('allows moving forward (one step or more) and cancelling an open order', () => {
    expect(checkOrderStatusChange(S.PENDING, S.CONFIRMED)).toEqual({ ok: true, noop: false });
    expect(checkOrderStatusChange(S.CONFIRMED, S.DELIVERED)).toEqual({ ok: true, noop: false });
    expect(checkOrderStatusChange(S.OUT_FOR_DELIVERY, S.CANCELLED)).toEqual({ ok: true, noop: false });
    expect(allowedOrderStatuses(S.PREPARING)).toEqual([S.OUT_FOR_DELIVERY, S.DELIVERED, S.CANCELLED]);
  });

  it('saving the same status again is a no-op, even on a closed order', () => {
    expect(checkOrderStatusChange(S.CANCELLED, S.CANCELLED)).toEqual({ ok: true, noop: true });
    expect(checkOrderStatusChange(S.PREPARING, S.PREPARING)).toEqual({ ok: true, noop: true });
  });

  it('refuses going back, reopening a closed order, and "refunded" by hand', () => {
    expect(checkOrderStatusChange(S.PREPARING, S.PENDING)).toMatchObject({ ok: false, code: 'INVALID_STATUS_CHANGE' });
    for (const closed of [S.DELIVERED, S.CANCELLED, S.REFUNDED]) {
      expect(checkOrderStatusChange(closed, S.PENDING)).toMatchObject({ ok: false, code: 'ORDER_CLOSED', allowed: [] });
    }
    expect(checkOrderStatusChange(S.DELIVERED, S.CANCELLED)).toMatchObject({ ok: false, code: 'ORDER_CLOSED' });
    for (const from of [S.PENDING, S.DELIVERED, S.CANCELLED]) {
      expect(checkOrderStatusChange(from, S.REFUNDED)).toMatchObject({ ok: false, code: 'REFUND_ON_PAYMENT' });
    }
  });
});

describe('OrdersService.updateStatus applies the rules', () => {
  function setup(status: OrderStatus, flipCount = 1) {
    const order = { id: 'o1', type: 'MARKETPLACE', status, items: [] };
    const prisma: any = {
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: flipCount }),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
          delivery: { findFirst: jest.fn().mockResolvedValue(null) },
          product: { update: jest.fn() },
        }),
      ),
    };
    const events = { emit: jest.fn() };
    const svc = new OrdersService(prisma, {} as any, {} as any, events as any, { get: jest.fn() } as any, {} as any);
    return { svc, prisma, events };
  }

  it('moves forward with a write conditional on the status it checked', async () => {
    const { svc, prisma } = setup(OrderStatus.CONFIRMED);
    await svc.updateStatus('o1', { status: OrderStatus.PREPARING });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: [OrderStatus.CONFIRMED] } },
      data: { status: OrderStatus.PREPARING },
    });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('409 when someone changed it in between, instead of overwriting', async () => {
    const { svc } = setup(OrderStatus.CONFIRMED, 0);
    await expect(svc.updateStatus('o1', { status: OrderStatus.PREPARING })).rejects.toBeInstanceOf(ConflictException);
  });

  it('409 for going back or reopening; 400 for "refunded" by hand; nothing written', async () => {
    const back = setup(OrderStatus.PREPARING);
    await expect(back.svc.updateStatus('o1', { status: OrderStatus.PENDING })).rejects.toBeInstanceOf(ConflictException);
    const closed = setup(OrderStatus.DELIVERED);
    await expect(closed.svc.updateStatus('o1', { status: OrderStatus.OUT_FOR_DELIVERY })).rejects.toBeInstanceOf(ConflictException);
    const refund = setup(OrderStatus.DELIVERED);
    await expect(refund.svc.updateStatus('o1', { status: OrderStatus.REFUNDED })).rejects.toBeInstanceOf(BadRequestException);
    for (const s of [back, closed, refund]) expect(s.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('cancelling an order already out for delivery still works (no restock)', async () => {
    const { svc, prisma } = setup(OrderStatus.OUT_FOR_DELIVERY);
    await svc.updateStatus('o1', { status: OrderStatus.CANCELLED });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: [OrderStatus.OUT_FOR_DELIVERY] } },
      data: { status: OrderStatus.CANCELLED },
    });
  });
});
