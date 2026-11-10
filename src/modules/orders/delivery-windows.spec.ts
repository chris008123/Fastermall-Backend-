import { BadRequestException, ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { OrdersService, withDeliveryWindow } from './orders.service';
import { RescheduleDeliveryDto } from './dto/reschedule-delivery.dto';

process.env.DELIVERY_CODE_ENCRYPTION_KEY = '0'.repeat(64);

// Ghana time = UTC. The requirement's example: order on 8 Nov before 9:00 ->
// 10:00–12:00; may move to 8 Nov 16:00–18:00 or 9 Nov 10:00–12:00 only.
const MORNING_8 = '2026-11-08T10:00:00.000Z';
const AFTERNOON_8 = '2026-11-08T16:00:00.000Z';
const MORNING_9 = '2026-11-09T10:00:00.000Z';
const AFTERNOON_9 = '2026-11-09T16:00:00.000Z';

function setup(now: string, order: any = {}) {
  const row = {
    id: 'o1',
    type: 'MARKETPLACE',
    status: 'PENDING',
    deliveryWindowStart: new Date(MORNING_8),
    originalWindowStart: new Date(MORNING_8),
    rescheduleCount: 0,
    delivery: { status: 'ASSIGNED', claimedByStaffId: null },
    ...order,
  };
  const prisma: any = {
    order: {
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockImplementation(({ data }) => {
        Object.assign(row, { deliveryWindowStart: data.deliveryWindowStart });
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  const events = { emit: jest.fn() };
  const svc = new OrdersService(prisma, {} as any, {} as any, events as any, { get: jest.fn() } as any, {} as any);
  (svc as any).now = () => new Date(now);
  return { svc, prisma, events, row };
}

describe('GET /orders/:id/delivery-windows', () => {
  it('lists the original window and the two after it, and which one is current', async () => {
    const { svc } = setup('2026-11-08T07:00:00Z');
    const out = await svc.getDeliveryWindows('o1', 'c1');
    expect(out.canReschedule).toBe(true);
    expect(out.current).toMatchObject({ start: MORNING_8, label: 'Sun 8 Nov, 10:00 AM – 12:00 PM' });
    expect(out.options.map((o) => [o.start, o.isCurrent, o.isOriginal, o.available])).toEqual([
      [MORNING_8, true, true, true],
      [AFTERNOON_8, false, false, true],
      [MORNING_9, false, false, true],
    ]);
  });

  it('after a move, still offers only the windows after the ORIGINAL one', async () => {
    const { svc } = setup('2026-11-08T07:00:00Z', { deliveryWindowStart: new Date(MORNING_9), rescheduleCount: 1 });
    const out = await svc.getDeliveryWindows('o1', 'c1');
    expect(out.options.map((o) => o.start)).toEqual([MORNING_8, AFTERNOON_8, MORNING_9]);
    expect(out.options.find((o) => o.isCurrent)?.start).toBe(MORNING_9);
  });

  it('says why it cannot be moved once the window has started or the order is on its way', async () => {
    const started = await setup('2026-11-08T10:30:00Z').svc.getDeliveryWindows('o1', 'c1');
    expect(started).toMatchObject({ canReschedule: false, reason: expect.stringMatching(/already started/) });
    expect(started.options.every((o) => !o.available)).toBe(true);

    const pickedUp = await setup('2026-11-08T07:00:00Z', { delivery: { status: 'PICKED_UP' } }).svc.getDeliveryWindows('o1', 'c1');
    expect(pickedUp.reason).toMatch(/picked up/);

    const cancelled = await setup('2026-11-08T07:00:00Z', { status: 'CANCELLED' }).svc.getDeliveryWindows('o1', 'c1');
    expect(cancelled.reason).toMatch(/cancelled/);
  });

  it("404s for someone else's order; food orders (no window) get a clear 400", async () => {
    const a = setup('2026-11-08T07:00:00Z');
    a.prisma.order.findFirst.mockResolvedValue(null);
    await expect(a.svc.getDeliveryWindows('o1', 'intruder')).rejects.toBeInstanceOf(NotFoundException);
    expect(a.prisma.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'o1', customerId: 'intruder' });

    const b = setup('2026-11-08T07:00:00Z', { type: 'FOOD', deliveryWindowStart: null, originalWindowStart: null });
    const err: any = await b.svc.getDeliveryWindows('o1', 'c1').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().code).toBe('NO_DELIVERY_WINDOW');
  });
});

describe('PATCH /orders/:id/delivery-window', () => {
  it.each([AFTERNOON_8, MORNING_9])('moves the delivery to %s and tells the customer and the admin running it', async (target) => {
    const { svc, prisma, events } = setup('2026-11-08T07:00:00Z', { delivery: { status: 'EN_ROUTE_TO_PICKUP', claimedByStaffId: 'admin1' } });
    const out = await svc.rescheduleDelivery('o1', 'c1', target);

    const call = prisma.order.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: 'o1', customerId: 'c1', deliveryWindowStart: new Date(MORNING_8) });
    expect(call.data).toMatchObject({ deliveryWindowStart: new Date(target), rescheduleCount: { increment: 1 }, rescheduledAt: expect.any(Date) });
    expect(call.data.deliveryWindowEnd.getTime() - call.data.deliveryWindowStart.getTime()).toBe(2 * 60 * 60 * 1000);
    expect(out.current.start).toBe(target);
    expect(events.emit).toHaveBeenCalledWith('order.delivery.rescheduled', expect.objectContaining({
      orderId: 'o1', customerId: 'c1', claimedByStaffId: 'admin1', to: expect.objectContaining({ start: target }),
    }));
  });

  it('can move back to the original window', async () => {
    const { svc, prisma } = setup('2026-11-08T07:00:00Z', { deliveryWindowStart: new Date(MORNING_9) });
    await svc.rescheduleDelivery('o1', 'c1', MORNING_8);
    expect(prisma.order.updateMany.mock.calls[0][0].data.deliveryWindowStart).toEqual(new Date(MORNING_8));
  });

  it.each([
    ['a third window later', AFTERNOON_9],
    ['an arbitrary future date', '2026-12-25T10:00:00.000Z'],
    ['a time that is not a window start', '2026-11-08T11:00:00.000Z'],
    ['a window before the original', '2026-11-07T16:00:00.000Z'],
  ])('refuses %s with the allowed list', async (_name, target) => {
    const { svc, prisma } = setup('2026-11-08T07:00:00Z');
    const err: any = await svc.rescheduleDelivery('o1', 'c1', target).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'WINDOW_NOT_ALLOWED' });
    expect(err.getResponse().allowed.map((w: any) => w.start)).toEqual([MORNING_8, AFTERNOON_8, MORNING_9]);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses once the current window has started (409 WINDOW_STARTED)', async () => {
    const { svc, prisma } = setup('2026-11-08T10:00:00Z');
    const err: any = await svc.rescheduleDelivery('o1', 'c1', AFTERNOON_8).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe('WINDOW_STARTED');
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a target window that has already started', async () => {
    // Moved to the 9 Nov morning earlier; it is now 8 Nov 17:00, so 8 Nov
    // afternoon has started and is no longer a choice.
    const { svc } = setup('2026-11-08T17:00:00Z', { deliveryWindowStart: new Date(MORNING_9) });
    const err: any = await svc.rescheduleDelivery('o1', 'c1', AFTERNOON_8).catch((e) => e);
    expect(err.getResponse().code).toBe('WINDOW_IN_THE_PAST');
  });

  it('refuses after pickup, and for finished or cancelled orders', async () => {
    for (const over of [{ delivery: { status: 'PICKED_UP' } }, { status: 'DELIVERED' }, { status: 'CANCELLED' }, { status: 'OUT_FOR_DELIVERY' }]) {
      const err: any = await setup('2026-11-08T07:00:00Z', over).svc.rescheduleDelivery('o1', 'c1', AFTERNOON_8).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
    }
  });

  it('picking the current window again changes nothing', async () => {
    const { svc, prisma, events } = setup('2026-11-08T07:00:00Z');
    await expect(svc.rescheduleDelivery('o1', 'c1', MORNING_8)).resolves.toMatchObject({ current: { start: MORNING_8 } });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('409 ORDER_CHANGED when the order changed in between (double tap, two phones)', async () => {
    const { svc, prisma, events } = setup('2026-11-08T07:00:00Z');
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    const err: any = await svc.rescheduleDelivery('o1', 'c1', AFTERNOON_8).catch((e) => e);
    expect(err.getResponse().code).toBe('ORDER_CHANGED');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('the body needs a real ISO timestamp', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: RescheduleDeliveryDto });
    await expect(check({ windowStart: AFTERNOON_8 })).resolves.toBeDefined();
    await expect(check({ windowStart: 'tomorrow' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('orders carry their delivery window', () => {
  it('adds deliveryWindow with a label, or null without one', () => {
    expect(withDeliveryWindow({ deliveryWindowStart: new Date(AFTERNOON_8) }).deliveryWindow).toEqual({
      slot: 'AFTERNOON', start: AFTERNOON_8, end: '2026-11-08T18:00:00.000Z', label: 'Sun 8 Nov, 4:00 PM – 6:00 PM',
    });
    expect(withDeliveryWindow({ deliveryWindowStart: null }).deliveryWindow).toBeNull();
  });
});
