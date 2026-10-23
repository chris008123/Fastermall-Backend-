import { ForbiddenException } from '@nestjs/common';
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
});
