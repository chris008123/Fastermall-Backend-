import { BadRequestException } from '@nestjs/common';
import { LogisticsService } from './logistics.service';

describe('LogisticsService payment gating', () => {
  const prisma: any = {
    deliveryPartnerProfile: { findUnique: jest.fn() },
    delivery: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    payment: { findUnique: jest.fn() },
    order: { update: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  let service: LogisticsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'partner-1' });
    prisma.delivery.findUnique.mockResolvedValue({
      id: 'd1',
      orderId: 'o1',
      partnerId: null,
      status: 'ASSIGNED',
    });
    service = new LogisticsService(prisma);
  });

  it('refuses to claim an order with no payment row', async () => {
    prisma.payment.findUnique.mockResolvedValue(null);
    await expect(service.claim('d1', 'staff-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.delivery.update).not.toHaveBeenCalled();
  });

  it('refuses to claim an unpaid online order', async () => {
    prisma.payment.findUnique.mockResolvedValue({ status: 'PENDING', method: 'MOBILE_MONEY' });
    await expect(service.claim('d1', 'staff-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.delivery.update).not.toHaveBeenCalled();
  });

  it('allows claiming a paid online order', async () => {
    prisma.payment.findUnique.mockResolvedValue({ status: 'SUCCESSFUL', method: 'CARD' });
    prisma.delivery.update.mockResolvedValue({ id: 'd1' });
    await service.claim('d1', 'staff-1');
    expect(prisma.delivery.update).toHaveBeenCalled();
  });

  it('allows claiming a cash-on-delivery order', async () => {
    prisma.payment.findUnique.mockResolvedValue({ status: 'PENDING', method: 'CASH' });
    prisma.delivery.update.mockResolvedValue({ id: 'd1' });
    await service.claim('d1', 'staff-1');
    expect(prisma.delivery.update).toHaveBeenCalled();
  });

  it('filters the unassigned list to paid or cash orders', async () => {
    prisma.delivery.findMany.mockResolvedValue([]);
    await service.findUnassigned();
    const where = prisma.delivery.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { orderId: null },
      {
        order: {
          payment: { OR: [{ status: 'SUCCESSFUL' }, { method: 'CASH' }] },
        },
      },
    ]);
  });
});
