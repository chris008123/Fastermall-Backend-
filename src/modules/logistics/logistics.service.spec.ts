<<<<<<< HEAD
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
=======
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LogisticsService } from './logistics.service';

describe('LogisticsService — food-only rule for delivery partners', () => {
  let svc: LogisticsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      delivery: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      deliveryPartnerProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', staffUserId: 's1' }),
      },
      $transaction: jest.fn(),
    };
    svc = new LogisticsService(prisma, new EventEmitter2());
  });

  describe('findUnassigned', () => {
    it('only returns food deliveries to a delivery partner', async () => {
      await svc.findUnassigned('DELIVERY_PARTNER');
      expect(prisma.delivery.findMany.mock.calls[0][0].where).toMatchObject({
        partnerId: null,
        order: { type: 'FOOD' },
      });
    });

    it('applies the food filter when the role is missing', async () => {
      await svc.findUnassigned(undefined);
      expect(prisma.delivery.findMany.mock.calls[0][0].where).toMatchObject({ order: { type: 'FOOD' } });
    });

    it('lets an admin see every unassigned delivery', async () => {
      await svc.findUnassigned('ADMIN');
      const where = prisma.delivery.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ partnerId: null, status: 'ASSIGNED' });
      expect(where.order).toBeUndefined();
    });
  });

  describe('claim', () => {
    it('refuses a marketplace delivery', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ id: 'd1', partnerId: null, status: 'ASSIGNED', order: { type: 'MARKETPLACE' } });
      await expect(svc.claim('d1', 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a laundry delivery (no order attached)', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ id: 'd2', partnerId: null, status: 'ASSIGNED', order: null, laundryOrderId: 'l1' });
      await expect(svc.claim('d2', 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lets a partner claim a food delivery', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ id: 'd3', orderId: 'o3', partnerId: null, status: 'ASSIGNED', order: { type: 'FOOD' } });
      prisma.$transaction.mockResolvedValue({ id: 'd3', status: 'EN_ROUTE_TO_PICKUP', orderId: 'o3', laundryOrderId: null, order: { customer: { id: 'c1' } }, laundryOrder: null });
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).resolves.toMatchObject({ id: 'd3' });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('updateStatus — ordered steps', () => {
    let tx: any;

    const delivery = (status: string) => ({ id: 'd1', status, partnerId: 'p1', orderId: 'o1' });
    const dto = (status: string) => ({ status }) as any;

    beforeEach(() => {
      tx = {
        delivery: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: 'd1',
            status: 'PICKED_UP',
            orderId: 'o1',
            laundryOrderId: null,
            order: { customer: { id: 'c1' } },
            laundryOrder: null,
          }),
        },
        order: { update: jest.fn() },
        deliveryStatusEvent: { create: jest.fn() },
      };
      prisma.$transaction.mockImplementation((fn: any) => fn(tx));
    });

    it('moves EN_ROUTE_TO_PICKUP to PICKED_UP and records the time', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivery('EN_ROUTE_TO_PICKUP'));
      await svc.updateStatus('d1', dto('PICKED_UP'), 's1');
      expect(tx.delivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'd1', status: 'EN_ROUTE_TO_PICKUP' },
        data: { status: 'PICKED_UP' },
      });
      expect(tx.deliveryStatusEvent.create).toHaveBeenCalledWith({
        data: { deliveryId: 'd1', status: 'PICKED_UP' },
      });
      expect(tx.order.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { status: 'OUT_FOR_DELIVERY' },
      });
    });

    it('moves PICKED_UP to EN_ROUTE_TO_CUSTOMER', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivery('PICKED_UP'));
      await svc.updateStatus('d1', dto('EN_ROUTE_TO_CUSTOMER'), 's1');
      expect(tx.delivery.updateMany).toHaveBeenCalled();
    });

    it.each([
      ['a DELIVERED job cannot be reopened', 'DELIVERED', 'PICKED_UP'],
      ['a FAILED job cannot be reopened', 'FAILED', 'PICKED_UP'],
      ['a step cannot be skipped', 'EN_ROUTE_TO_PICKUP', 'EN_ROUTE_TO_CUSTOMER'],
      ['a step cannot go backwards', 'PICKED_UP', 'EN_ROUTE_TO_PICKUP'],
      ['an unclaimed job cannot be moved', 'ASSIGNED', 'PICKED_UP'],
      ['DELIVERED cannot be set here', 'EN_ROUTE_TO_CUSTOMER', 'DELIVERED'],
      ['FAILED cannot be set here', 'PICKED_UP', 'FAILED'],
    ])('rejects: %s', async (_name, from, to) => {
      prisma.delivery.findUnique.mockResolvedValue(delivery(from));
      await expect(svc.updateStatus('d1', dto(to), 's1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('treats a repeated tap on the current step as a no-op', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivery('PICKED_UP'));
      await expect(svc.updateStatus('d1', dto('PICKED_UP'), 's1')).resolves.toMatchObject({ status: 'PICKED_UP' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects when the status changed between read and write', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivery('EN_ROUTE_TO_PICKUP'));
      tx.delivery.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.updateStatus('d1', dto('PICKED_UP'), 's1')).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.deliveryStatusEvent.create).not.toHaveBeenCalled();
    });

    it('rejects a partner who does not own the delivery', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ ...delivery('PICKED_UP'), partnerId: 'other' });
      await expect(svc.updateStatus('d1', dto('EN_ROUTE_TO_CUSTOMER'), 's1')).rejects.toBeInstanceOf(BadRequestException);
    });
>>>>>>> 8cc658926c7d41e19e8b66cee7d6673a28dec153
  });
});
