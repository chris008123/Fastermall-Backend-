import {
  laundryStatusCopy,
  MAX_RETENTION_MS,
  NotificationsService,
  orderStatusCopy,
  READ_RETENTION_MS,
} from './notifications.service';

// Fewer, clearer customer pushes; stale partner job alerts removed; old rows
// cleaned up.

function setup(over: any = {}) {
  const prisma: any = {
    notification: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    order: { findUnique: jest.fn() },
    laundryOrder: { findUnique: jest.fn() },
    ...over,
  };
  const push = { sendToOwners: jest.fn().mockResolvedValue(undefined) };
  return { svc: new NotificationsService(prisma, push as any), prisma, push };
}

describe('order status copy', () => {
  it('names the vendor and says what happened', () => {
    expect(orderStatusCopy('PREPARING', '#AB12', "Mama's Kitchen")).toEqual({
      title: "Mama's Kitchen is preparing your order",
      body: 'Order #AB12 is being prepared.',
    });
    expect(orderStatusCopy('CONFIRMED', '#AB12', null)?.title).toBe('The shop accepted your order');
  });

  it('says nothing for PENDING (Order placed covers it)', () => {
    expect(orderStatusCopy('PENDING', '#AB12')).toBeNull();
  });

  it('is used for the stored notification and the push', async () => {
    const { svc, prisma, push } = setup();
    await svc.onOrderStatusUpdated({ id: 'abcdef1234', customerId: 'c1', status: 'DELIVERED', vendorName: 'Pizzaman' });
    expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({ title: 'Order delivered', type: 'ORDER_STATUS_UPDATED' });
    expect(push.sendToOwners.mock.calls[0][1]).toMatchObject({ title: 'Order delivered' });

    await svc.onOrderStatusUpdated({ id: 'abcdef1234', customerId: 'c1', status: 'PENDING' });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });
});

describe('laundry', () => {
  it('only tells the customer about the steps that matter to them', async () => {
    const { svc, prisma, push } = setup();
    const all = [
      'RECEIVED', 'INSPECTED', 'TAGGED', 'WASHING', 'DRYING', 'IRONING', 'FOLDING',
      'QUALITY_CHECK', 'PACKAGED', 'READY_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'COMPLETED',
    ];
    for (const status of all) await svc.onLaundryStatusUpdated({ id: 'l1', customerId: 'c1', status });

    expect(prisma.notification.create.mock.calls.map((c: any) => c[0].data.title)).toEqual([
      "We've got your laundry",
      'Your laundry is being washed',
      'Your laundry is ready',
      'Your laundry is on the way',
      'Laundry order complete',
    ]);
    expect(push.sendToOwners).toHaveBeenCalledTimes(5);
  });

  it('tells drop-off customers to collect, pickup customers that it is coming', () => {
    expect(laundryStatusCopy('READY_FOR_DELIVERY', '#L1', 'dropoff')?.body).toContain('ready for you to collect');
    expect(laundryStatusCopy('READY_FOR_DELIVERY', '#L1', 'Pickup')?.body).toContain("We'll bring it to you");
  });
});

describe('payment confirmed', () => {
  it('is not pushed right after "Order placed", but is still in the list', async () => {
    const { svc, prisma, push } = setup();
    prisma.order.findUnique.mockResolvedValue({ customerId: 'c1', createdAt: new Date(Date.now() - 30_000) });
    await svc.onPaymentSuccessful({ orderId: 'o1' });
    expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({ type: 'PAYMENT_SUCCESSFUL', userId: 'c1' });
    expect(push.sendToOwners).not.toHaveBeenCalled();
  });

  it('is pushed when it comes later (cash at the door, slow approval)', async () => {
    const { svc, prisma, push } = setup();
    prisma.order.findUnique.mockResolvedValue({ customerId: 'c1', createdAt: new Date(Date.now() - 40 * 60_000) });
    await svc.onPaymentSuccessful({ orderId: 'o1' });
    expect(push.sendToOwners).toHaveBeenCalledWith({ userIds: ['c1'] }, expect.objectContaining({ title: 'Payment successful' }));
  });
});

describe('a claimed delivery', () => {
  it('removes every partner’s "New delivery available" alert for it', async () => {
    const { svc, prisma } = setup();
    await svc.onDeliveryClaimed({ deliveryId: 'd1', staffUserId: 's1' });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { type: 'DELIVERY_AVAILABLE', staffUserId: { not: null }, data: { path: ['deliveryId'], equals: 'd1' } },
    });
  });
});

describe('cleanup', () => {
  it('deletes read notifications after 90 days and any after a year', async () => {
    const { svc, prisma } = setup();
    const now = new Date('2026-11-14T00:00:00Z');
    await expect(svc.cleanupOld(now)).resolves.toBe(3);
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { isRead: true, createdAt: { lt: new Date(now.getTime() - READ_RETENTION_MS) } },
          { createdAt: { lt: new Date(now.getTime() - MAX_RETENTION_MS) } },
        ],
      },
    });
  });

  it('never throws', async () => {
    const { svc, prisma } = setup();
    prisma.notification.deleteMany.mockRejectedValue(new Error('db down'));
    await expect(svc.cleanupOld()).resolves.toBe(0);
  });
});
