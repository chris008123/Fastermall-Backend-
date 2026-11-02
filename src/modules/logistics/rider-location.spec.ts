import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LogisticsService } from './logistics.service';

describe('PATCH /logistics/deliveries/:id/location', () => {
  let svc: LogisticsService;
  let prisma: any;
  const here = { lat: 5.65, lng: -0.19 };

  beforeEach(() => {
    prisma = {
      delivery: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliveryPartnerProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }) },
    };
    svc = new LogisticsService(prisma, new EventEmitter2());
  });

  const food = (over: object = {}) => ({ id: 'd1', partnerId: 'p1', claimedByStaffId: null, status: 'PICKED_UP', order: { type: 'FOOD' }, ...over });
  const market = (over: object = {}) => ({ id: 'd2', partnerId: null, claimedByStaffId: 'admin1', status: 'EN_ROUTE_TO_CUSTOMER', order: { type: 'MARKETPLACE' }, ...over });

  it('stores the partner position, only while the delivery is in progress', async () => {
    prisma.delivery.findUnique.mockResolvedValue(food());
    const result = await svc.updateRiderLocation('d1', here, 's1', 'DELIVERY_PARTNER');
    const args = prisma.delivery.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'd1', status: { in: ['EN_ROUTE_TO_PICKUP', 'PICKED_UP', 'EN_ROUTE_TO_CUSTOMER'] } });
    expect(args.data).toMatchObject({ riderLat: 5.65, riderLng: -0.19 });
    expect(args.data.riderLocationAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({ riderLat: 5.65, riderLng: -0.19 });
  });

  it('lets the admin who accepted a marketplace delivery report it', async () => {
    prisma.delivery.findUnique.mockResolvedValue(market());
    await svc.updateRiderLocation('d2', here, 'admin1', 'ADMIN');
    expect(prisma.delivery.updateMany).toHaveBeenCalled();
  });

  it('rejects a partner who is not on the delivery', async () => {
    prisma.delivery.findUnique.mockResolvedValue(food({ partnerId: 'other' }));
    await expect(svc.updateRiderLocation('d1', here, 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.delivery.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a partner on an admin-run delivery', async () => {
    prisma.delivery.findUnique.mockResolvedValue(market());
    await expect(svc.updateRiderLocation('d2', here, 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects once the delivery is finished', async () => {
    prisma.delivery.findUnique.mockResolvedValue(food({ status: 'DELIVERED' }));
    prisma.delivery.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.updateRiderLocation('d1', here, 's1', 'DELIVERY_PARTNER')).rejects.toThrow(
      'Location can only be shared while the delivery is in progress',
    );
  });
});
