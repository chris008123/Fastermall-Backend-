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
  });
});
