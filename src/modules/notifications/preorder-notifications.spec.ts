import { NotificationsService } from './notifications.service';

describe('pre-order notifications', () => {
  function setup() {
    const prisma: any = {
      notification: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}) },
      staffUser: { findMany: jest.fn().mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]) },
    };
    const push = { sendToOwners: jest.fn().mockResolvedValue(undefined) };
    return { svc: new NotificationsService(prisma, push as any), prisma, push };
  }

  it('a new request goes to every active admin', async () => {
    const { svc, prisma } = setup();
    await svc.onPreOrderSubmitted({ requestId: 'abcdef12-0000' });
    expect(prisma.staffUser.findMany.mock.calls[0][0].where).toEqual({ isActive: true, role: 'ADMIN' });
    expect(prisma.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ staffUserId: 'a1', type: 'PREORDER_SUBMITTED', data: { preOrderId: 'abcdef12-0000' } });
  });

  it('the customer hears about the quote (price and date) and the outcome', async () => {
    const { svc, prisma } = setup();
    await svc.onPreOrderQuoted({ requestId: 'r1', customerId: 'c1', price: 450, estimatedDate: '2026-11-25T00:00:00Z' });
    expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({ userId: 'c1', type: 'PREORDER_QUOTED', body: expect.stringContaining('GH₵ 450.00, ready around 25 Nov') });
    await svc.onPreOrderStatusUpdated({ requestId: 'r1', customerId: 'c1', status: 'FULFILLED' });
    await svc.onPreOrderStatusUpdated({ requestId: 'r1', customerId: 'c1', status: 'CANCELLED', note: 'Out of leather' });
    expect(prisma.notification.create.mock.calls.map((c: any) => c[0].data.type)).toEqual(['PREORDER_QUOTED', 'PREORDER_FULFILLED', 'PREORDER_CANCELLED']);
    expect(prisma.notification.create.mock.calls[2][0].data.body).toContain('Out of leather');
  });

  it('admins hear when the customer accepts or declines', async () => {
    const { svc, prisma } = setup();
    await svc.onPreOrderDecided({ requestId: 'r1', status: 'ACCEPTED' });
    expect(prisma.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ title: 'Pre-order accepted', type: 'PREORDER_ACCEPTED' });
  });

  it('every admin is told when an automatic refund after a cancel fails', async () => {
    const { svc, prisma } = setup();
    await svc.onOrderRefundFailed({ orderId: 'abcdef12-0000', paymentId: 'pay1', amount: '45.5' });
    expect(prisma.staffUser.findMany.mock.calls[0][0].where).toEqual({ isActive: true, role: 'ADMIN' });
    expect(prisma.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({
      staffUserId: 'a1',
      title: 'Refund needed',
      type: 'REFUND_NEEDED',
      body: expect.stringContaining('GH₵ 45.50'),
      data: { orderId: 'abcdef12-0000', paymentId: 'pay1' },
    });
  });
});
