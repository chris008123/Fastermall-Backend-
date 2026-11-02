import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
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
      expect(where).toEqual({ partnerId: null, claimedByStaffId: null, status: 'ASSIGNED' });
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

  });

  describe('claim — limits and races', () => {
    let tx: any;
    const food = { id: 'd3', orderId: 'o3', partnerId: null, status: 'ASSIGNED', order: { type: 'FOOD' } };

    beforeEach(() => {
      delete process.env.MAX_ACTIVE_FOOD_DELIVERIES;
      tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        delivery: {
          count: jest.fn().mockResolvedValue(0),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: 'd3', status: 'EN_ROUTE_TO_PICKUP', orderId: 'o3', laundryOrderId: null,
            order: { customer: { id: 'c1' } }, laundryOrder: null,
          }),
        },
        order: { update: jest.fn() },
        deliveryStatusEvent: { create: jest.fn() },
      };
      prisma.$transaction.mockImplementation((fn: any) => fn(tx));
      prisma.delivery.findUnique.mockResolvedValue(food);
    });

    afterAll(() => {
      delete process.env.MAX_ACTIVE_FOOD_DELIVERIES;
    });

    it('lets a partner claim a food delivery, only while it is still unclaimed', async () => {
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).resolves.toMatchObject({ id: 'd3' });
      expect(tx.delivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'd3', partnerId: null, status: 'ASSIGNED' },
        data: { partnerId: 'p1', status: 'EN_ROUTE_TO_PICKUP' },
      });
      expect(tx.$queryRaw).toHaveBeenCalled(); // partner row lock
      expect(tx.deliveryStatusEvent.create).toHaveBeenCalledWith({ data: { deliveryId: 'd3', status: 'EN_ROUTE_TO_PICKUP' } });
      expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o3' }, data: { status: 'PREPARING' } });
    });

    it('returns 409 when another partner took it first (lost the race)', async () => {
      tx.delivery.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ConflictException);
      expect(tx.deliveryStatusEvent.create).not.toHaveBeenCalled();
      expect(tx.order.update).not.toHaveBeenCalled();
    });

    it('returns 409 when the delivery already has a partner', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ ...food, partnerId: 'other' });
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns 409 when the delivery is no longer ASSIGNED', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ ...food, status: 'FAILED' });
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a 4th active food delivery with a readable 400', async () => {
      tx.delivery.count.mockResolvedValue(3);
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).rejects.toThrow(
        new BadRequestException('You can carry up to 3 food orders at once. Finish one before accepting another.'),
      );
      expect(tx.delivery.updateMany).not.toHaveBeenCalled();
    });

    it("counts only this partner's unfinished food deliveries", async () => {
      await svc.claim('d3', 's1', 'DELIVERY_PARTNER');
      const where = tx.delivery.count.mock.calls[0][0].where;
      expect(where.partnerId).toBe('p1');
      expect(where.order).toEqual({ type: 'FOOD' });
      expect(where.status.in).toEqual(
        expect.arrayContaining(['ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'PICKED_UP', 'EN_ROUTE_TO_CUSTOMER']),
      );
      expect(where.status.in).not.toContain('DELIVERED');
      expect(where.status.in).not.toContain('FAILED');
    });

    it('allows a claim at 2 active (a delivered one freed a slot)', async () => {
      tx.delivery.count.mockResolvedValue(2);
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).resolves.toMatchObject({ id: 'd3' });
    });

    it('does not limit admins', async () => {
      tx.delivery.count.mockResolvedValue(10);
      await expect(svc.claim('d3', 's1', 'ADMIN')).resolves.toMatchObject({ id: 'd3' });
      expect(tx.delivery.count).not.toHaveBeenCalled();
    });

    it('reads the limit from MAX_ACTIVE_FOOD_DELIVERIES', async () => {
      process.env.MAX_ACTIVE_FOOD_DELIVERIES = '5';
      tx.delivery.count.mockResolvedValue(4);
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).resolves.toMatchObject({ id: 'd3' });
      tx.delivery.count.mockResolvedValue(5);
      await expect(svc.claim('d3', 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateStatus — ordered steps', () => {
    let tx: any;

    const delivery = (status: string) => ({ id: 'd1', status, partnerId: 'p1', orderId: 'o1', order: { type: 'FOOD' } });
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
      ['an ASSIGNED job cannot skip to PICKED_UP', 'ASSIGNED', 'PICKED_UP'],
      ['DELIVERED cannot be set here', 'EN_ROUTE_TO_CUSTOMER', 'DELIVERED'],
      ['FAILED from ASSIGNED', 'ASSIGNED', 'FAILED'],
      ['FAILED from DELIVERED', 'DELIVERED', 'FAILED'],
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

    it.each(['EN_ROUTE_TO_PICKUP', 'PICKED_UP', 'EN_ROUTE_TO_CUSTOMER'])(
      'R1: lets the partner mark FAILED from %s, leaving the order status for an admin',
      async (from) => {
        prisma.delivery.findUnique.mockResolvedValue(delivery(from));
        await svc.updateStatus('d1', dto('FAILED'), 's1');
        expect(tx.delivery.updateMany).toHaveBeenCalledWith({
          where: { id: 'd1', status: from },
          data: { status: 'FAILED' },
        });
        expect(tx.deliveryStatusEvent.create).toHaveBeenCalledWith({ data: { deliveryId: 'd1', status: 'FAILED' } });
        expect(tx.order.update).not.toHaveBeenCalled();
      },
    );

    it('R1: a repeated FAILED tap on a FAILED job is a no-op', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivery('FAILED'));
      await expect(svc.updateStatus('d1', dto('FAILED'), 's1')).resolves.toMatchObject({ status: 'FAILED' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('R1: a partner not assigned to the delivery cannot fail it', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ ...delivery('PICKED_UP'), partnerId: 'other' });
      await expect(svc.updateStatus('d1', dto('FAILED'), 's1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('R7: the assigned partner can start an admin-assigned delivery', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivery('ASSIGNED'));
      await svc.updateStatus('d1', dto('EN_ROUTE_TO_PICKUP'), 's1');
      expect(tx.delivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'd1', status: 'ASSIGNED' },
        data: { status: 'EN_ROUTE_TO_PICKUP' },
      });
      expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { status: 'PREPARING' } });
    });

    it('R7: an unclaimed delivery still has to go through claim', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ ...delivery('ASSIGNED'), partnerId: null });
      await expect(svc.updateStatus('d1', dto('EN_ROUTE_TO_PICKUP'), 's1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('admin-run marketplace and laundry deliveries', () => {
    let tx: any;
    const market = (over: object = {}) => ({
      id: 'm1', orderId: 'o9', laundryOrderId: null, partnerId: null, claimedByStaffId: null,
      status: 'ASSIGNED', order: { type: 'MARKETPLACE' }, ...over,
    });
    const laundry = (over: object = {}) => ({
      id: 'l1', orderId: null, laundryOrderId: 'lo1', partnerId: null, claimedByStaffId: null,
      status: 'ASSIGNED', order: null, ...over,
    });
    const dto = (status: string) => ({ status }) as any;

    beforeEach(() => {
      tx = {
        $queryRaw: jest.fn(),
        delivery: {
          count: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: 'm1', status: 'EN_ROUTE_TO_PICKUP', orderId: 'o9', laundryOrderId: null,
            order: { customer: { id: 'c1' } }, laundryOrder: null,
          }),
        },
        order: { update: jest.fn() },
        deliveryStatusEvent: { create: jest.fn() },
      };
      prisma.$transaction.mockImplementation((fn: any) => fn(tx));
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(null); // admins have no partner profile
    });

    describe('claim', () => {
      it.each([['marketplace', market()], ['laundry', laundry()]])(
        'lets an admin with no partner profile accept a %s delivery',
        async (_name, d: any) => {
          prisma.delivery.findUnique.mockResolvedValue(d);
          await svc.claim(d.id, 'admin1', 'ADMIN');
          expect(tx.delivery.updateMany).toHaveBeenCalledWith({
            where: { id: d.id, partnerId: null, claimedByStaffId: null, status: 'ASSIGNED' },
            data: { claimedByStaffId: 'admin1', status: 'EN_ROUTE_TO_PICKUP' },
          });
          expect(tx.deliveryStatusEvent.create).toHaveBeenCalledWith({ data: { deliveryId: d.id, status: 'EN_ROUTE_TO_PICKUP' } });
          expect(tx.delivery.count).not.toHaveBeenCalled(); // no 3-order limit
          expect(tx.$queryRaw).not.toHaveBeenCalled();
        },
      );

      it('moves a marketplace order to PREPARING when accepted', async () => {
        prisma.delivery.findUnique.mockResolvedValue(market());
        await svc.claim('m1', 'admin1', 'ADMIN');
        expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o9' }, data: { status: 'PREPARING' } });
      });

      it('returns 409 when another admin accepted it first', async () => {
        prisma.delivery.findUnique.mockResolvedValue(market({ claimedByStaffId: 'admin2' }));
        await expect(svc.claim('m1', 'admin1', 'ADMIN')).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('returns 409 when two admins accept at the same moment', async () => {
        prisma.delivery.findUnique.mockResolvedValue(market());
        tx.delivery.updateMany.mockResolvedValue({ count: 0 });
        await expect(svc.claim('m1', 'admin1', 'ADMIN')).rejects.toBeInstanceOf(ConflictException);
        expect(tx.deliveryStatusEvent.create).not.toHaveBeenCalled();
      });

      it('still refuses a delivery partner', async () => {
        prisma.delivery.findUnique.mockResolvedValue(market());
        await expect(svc.claim('m1', 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('a food claim by an admin without a partner profile is still refused', async () => {
        prisma.delivery.findUnique.mockResolvedValue({ ...market(), order: { type: 'FOOD' } });
        await expect(svc.claim('m1', 'admin1', 'ADMIN')).rejects.toThrow('You are not registered as a delivery partner');
      });
    });

    describe('updateStatus', () => {
      it.each([
        ['ASSIGNED', 'EN_ROUTE_TO_PICKUP'],
        ['EN_ROUTE_TO_PICKUP', 'PICKED_UP'],
        ['PICKED_UP', 'EN_ROUTE_TO_CUSTOMER'],
        ['EN_ROUTE_TO_CUSTOMER', 'DELIVERED'],
        ['PICKED_UP', 'FAILED'],
      ])('lets the admin who accepted it move %s -> %s', async (from, to) => {
        prisma.delivery.findUnique.mockResolvedValue(market({ status: from, claimedByStaffId: 'admin1' }));
        await svc.updateStatus('m1', dto(to), 'admin1', 'ADMIN');
        expect(tx.delivery.updateMany).toHaveBeenCalledWith({ where: { id: 'm1', status: from }, data: { status: to } });
        expect(tx.deliveryStatusEvent.create).toHaveBeenCalledWith({ data: { deliveryId: 'm1', status: to } });
      });

      it('finishing without a code marks the marketplace order DELIVERED', async () => {
        prisma.delivery.findUnique.mockResolvedValue(market({ status: 'EN_ROUTE_TO_CUSTOMER', claimedByStaffId: 'admin1' }));
        await svc.updateStatus('m1', dto('DELIVERED'), 'admin1', 'ADMIN');
        expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o9' }, data: { status: 'DELIVERED' } });
      });

      it('finishes a laundry delivery without a code', async () => {
        prisma.delivery.findUnique.mockResolvedValue(laundry({ status: 'EN_ROUTE_TO_CUSTOMER', claimedByStaffId: 'admin1' }));
        await svc.updateStatus('l1', dto('DELIVERED'), 'admin1', 'ADMIN');
        expect(tx.delivery.updateMany).toHaveBeenCalledWith({ where: { id: 'l1', status: 'EN_ROUTE_TO_CUSTOMER' }, data: { status: 'DELIVERED' } });
        expect(tx.order.update).not.toHaveBeenCalled();
      });

      it.each([
        ['skip to DELIVERED', 'PICKED_UP', 'DELIVERED'],
        ['reopen a DELIVERED job', 'DELIVERED', 'PICKED_UP'],
        ['skip a step', 'EN_ROUTE_TO_PICKUP', 'EN_ROUTE_TO_CUSTOMER'],
      ])('rejects: %s', async (_name, from, to) => {
        prisma.delivery.findUnique.mockResolvedValue(market({ status: from, claimedByStaffId: 'admin1' }));
        await expect(svc.updateStatus('m1', dto(to), 'admin1', 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('rejects an admin who did not accept the delivery', async () => {
        prisma.delivery.findUnique.mockResolvedValue(market({ status: 'PICKED_UP', claimedByStaffId: 'admin2' }));
        await expect(svc.updateStatus('m1', dto('EN_ROUTE_TO_CUSTOMER'), 'admin1', 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejects an unaccepted delivery (must go through claim)', async () => {
        prisma.delivery.findUnique.mockResolvedValue(market());
        await expect(svc.updateStatus('m1', dto('EN_ROUTE_TO_PICKUP'), 'admin1', 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejects a delivery partner', async () => {
        prisma.delivery.findUnique.mockResolvedValue(market({ status: 'PICKED_UP', claimedByStaffId: 'admin1' }));
        await expect(svc.updateStatus('m1', dto('EN_ROUTE_TO_CUSTOMER'), 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    describe('myDeliveries', () => {
      it("returns the deliveries the admin accepted", async () => {
        await svc.myDeliveries('admin1', 'ADMIN');
        expect(prisma.delivery.findMany.mock.calls[0][0].where).toEqual({ claimedByStaffId: 'admin1' });
      });

      it('still returns a partner their own deliveries', async () => {
        prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'p1' });
        await svc.myDeliveries('s1', 'DELIVERY_PARTNER');
        expect(prisma.delivery.findMany.mock.calls[0][0].where).toEqual({ partnerId: 'p1' });
      });
    });
  });
});
