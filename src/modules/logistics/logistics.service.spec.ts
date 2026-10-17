import { BadRequestException } from '@nestjs/common';
import { LogisticsService } from './logistics.service';

describe('LogisticsService payment gating', () => {
  const prisma: any = {
    deliveryPartnerProfile: { findUnique: jest.fn() },
    delivery: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
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
    expect(prisma.delivery.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to claim an unpaid online order', async () => {
    prisma.payment.findUnique.mockResolvedValue({ status: 'PENDING', method: 'MOBILE_MONEY' });
    await expect(service.claim('d1', 'staff-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.delivery.updateMany).not.toHaveBeenCalled();
  });

  it('allows claiming a paid online order', async () => {
    prisma.payment.findUnique.mockResolvedValue({ status: 'SUCCESSFUL', method: 'CARD' });
    prisma.delivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.delivery.findUniqueOrThrow.mockResolvedValue({ id: 'd1' });
    await service.claim('d1', 'staff-1');
    expect(prisma.delivery.updateMany).toHaveBeenCalled();
  });

  it('allows claiming a cash-on-delivery order', async () => {
    prisma.payment.findUnique.mockResolvedValue({ status: 'PENDING', method: 'CASH' });
    prisma.delivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.delivery.findUniqueOrThrow.mockResolvedValue({ id: 'd1' });
    await service.claim('d1', 'staff-1');
    expect(prisma.delivery.updateMany).toHaveBeenCalled();
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

describe('LogisticsService claim race', () => {
  const prisma: any = {
    deliveryPartnerProfile: { findUnique: jest.fn() },
    delivery: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
    payment: { findUnique: jest.fn() },
    order: { update: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'partner-2' });
    prisma.delivery.findUnique.mockResolvedValue({ id: 'd1', orderId: null, partnerId: null, status: 'ASSIGNED' });
  });

  it('only matches while the delivery is still unclaimed', async () => {
    prisma.delivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.delivery.findUniqueOrThrow.mockResolvedValue({ id: 'd1' });
    await new LogisticsService(prisma).claim('d1', 'staff-2');
    expect(prisma.delivery.updateMany.mock.calls[0][0].where).toEqual({
      id: 'd1',
      partnerId: null,
      status: 'ASSIGNED',
    });
  });

  it('tells the second courier it is gone when the first already won', async () => {
    prisma.delivery.updateMany.mockResolvedValue({ count: 0 });
    await expect(new LogisticsService(prisma).claim('d1', 'staff-2')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });
});

describe('LogisticsService.verifyDeliveryCode attempt limit', () => {
  const bcrypt = require('bcrypt');
  const prisma: any = {
    deliveryPartnerProfile: { findUnique: jest.fn() },
    delivery: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
    order: { update: jest.fn() },
    driverEarning: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  let hash: string;

  beforeAll(async () => {
    hash = await bcrypt.hash('123456', 4);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'partner-1' });
    prisma.delivery.findUnique.mockResolvedValue({
      id: 'd1',
      orderId: 'o1',
      partnerId: 'partner-1',
      deliveryCodeUsed: false,
      deliveryCodeHash: hash,
    });
  });

  it('does not even compare the code once the attempts are used up', async () => {
    // reset step, then the guarded reservation matches nothing
    prisma.delivery.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    await expect(
      new LogisticsService(prisma).verifyDeliveryCode('d1', '123456', 'staff-1'),
    ).rejects.toThrow(/Too many incorrect attempts/);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('reserves an attempt with a count guard, then locks after the last wrong one', async () => {
    prisma.delivery.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      new LogisticsService(prisma).verifyDeliveryCode('d1', '000000', 'staff-1'),
    ).rejects.toThrow('Invalid delivery code');

    const reserve = prisma.delivery.updateMany.mock.calls[1][0];
    expect(reserve.where.deliveryCodeAttempts).toEqual({ lt: 5 });
    expect(reserve.data).toEqual({ deliveryCodeAttempts: { increment: 1 } });

    const lock = prisma.delivery.updateMany.mock.calls[2][0];
    expect(lock.where.deliveryCodeAttempts).toEqual({ gte: 5 });
    expect(lock.data.deliveryCodeLockedUntil).toBeInstanceOf(Date);
  });

  it('marks delivered and pays once on the right code', async () => {
    prisma.delivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.delivery.findUniqueOrThrow.mockResolvedValue({ id: 'd1', status: 'DELIVERED' });
    prisma.driverEarning.findFirst.mockResolvedValue(null);

    await new LogisticsService(prisma).verifyDeliveryCode('d1', '123456', 'staff-1');

    expect(prisma.driverEarning.create).toHaveBeenCalledTimes(1);
    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { status: 'DELIVERED' } });
  });

  it('pays nothing if a parallel request already used the code', async () => {
    prisma.delivery.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reset
      .mockResolvedValueOnce({ count: 1 }) // reserve attempt
      .mockResolvedValueOnce({ count: 0 }); // used-flag flip lost the race
    await expect(
      new LogisticsService(prisma).verifyDeliveryCode('d1', '123456', 'staff-1'),
    ).rejects.toThrow(/already been used/);
    expect(prisma.driverEarning.create).not.toHaveBeenCalled();
  });
});

describe('LogisticsService.updateStatus transitions', () => {
  const prisma: any = {
    deliveryPartnerProfile: { findUnique: jest.fn() },
    delivery: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
    order: { update: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'partner-1' });
  });

  const withStatus = (status: string) =>
    prisma.delivery.findUnique.mockResolvedValue({ id: 'd1', orderId: 'o1', partnerId: 'partner-1', status });

  it('cannot reopen a delivered delivery', async () => {
    withStatus('DELIVERED');
    await expect(
      new LogisticsService(prisma).updateStatus('d1', { status: 'PICKED_UP' } as any, 'staff-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.delivery.updateMany).not.toHaveBeenCalled();
  });

  it('cannot move backwards', async () => {
    withStatus('EN_ROUTE_TO_CUSTOMER');
    await expect(
      new LogisticsService(prisma).updateStatus('d1', { status: 'PICKED_UP' } as any, 'staff-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot set DELIVERED directly', async () => {
    withStatus('EN_ROUTE_TO_CUSTOMER');
    await expect(
      new LogisticsService(prisma).updateStatus('d1', { status: 'DELIVERED' } as any, 'staff-1'),
    ).rejects.toThrow('Invalid delivery status');
  });

  it('moves forward and writes only if the status is unchanged', async () => {
    withStatus('EN_ROUTE_TO_PICKUP');
    prisma.delivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.delivery.findUniqueOrThrow.mockResolvedValue({ id: 'd1' });
    await new LogisticsService(prisma).updateStatus('d1', { status: 'PICKED_UP' } as any, 'staff-1');
    expect(prisma.delivery.updateMany.mock.calls[0][0].where).toEqual({ id: 'd1', status: 'EN_ROUTE_TO_PICKUP' });
  });

  it('refuses if someone changed the status in between', async () => {
    withStatus('EN_ROUTE_TO_PICKUP');
    prisma.delivery.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      new LogisticsService(prisma).updateStatus('d1', { status: 'PICKED_UP' } as any, 'staff-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });
});
