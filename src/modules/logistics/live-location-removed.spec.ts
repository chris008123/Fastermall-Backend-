import { GoneException } from '@nestjs/common';
import { LogisticsController, RIDER_LOCATION_REMOVED_MESSAGE } from './logistics.controller';
import { LogisticsService } from './logistics.service';
import {
  DELIVERY_LOCATION_KEYS,
  SAFE_DELIVERY_SELECT,
  stripDeliverySecrets,
} from '../../shared/utils/delivery-secrets';
import { OrdersService } from '../orders/orders.service';

process.env.DELIVERY_CODE_ENCRYPTION_KEY = '0'.repeat(64);

// Live maps and rider tracking were removed (Nov 2026). The columns stay in
// the database, but nothing writes the rider position and no response
// carries coordinates.
const LOCATION = {
  pickupLat: 5.6,
  pickupLng: -0.2,
  dropoffLat: 5.7,
  dropoffLng: -0.1,
  riderLat: 5.65,
  riderLng: -0.19,
  riderLocationAt: new Date(),
};

function expectNoLocation(value: unknown) {
  const json = JSON.stringify(value);
  for (const key of DELIVERY_LOCATION_KEYS) expect(json).not.toContain(`"${key}"`);
}

describe('rider location route', () => {
  it('answers 410 Gone and never touches the database', () => {
    const prisma: any = { delivery: { updateMany: jest.fn(), findUnique: jest.fn() } };
    const controller = new LogisticsController(new LogisticsService(prisma, { emit: jest.fn() } as any));
    expect(() => (controller as any).updateRiderLocation()).toThrow(GoneException);
    expect(() => (controller as any).updateRiderLocation()).toThrow(RIDER_LOCATION_REMOVED_MESSAGE);
    expect(prisma.delivery.updateMany).not.toHaveBeenCalled();
  });

  it('the service no longer has a way to store a rider position', () => {
    expect((LogisticsService.prototype as any).updateRiderLocation).toBeUndefined();
  });
});

describe('delivery responses carry no location', () => {
  it('stripDeliverySecrets drops every location field and keeps the rest', () => {
    const out = stripDeliverySecrets({ id: 'd1', status: 'PICKED_UP', distanceKm: 1.2, ...LOCATION });
    expectNoLocation(out);
    expect(out).toEqual({ id: 'd1', status: 'PICKED_UP', distanceKm: 1.2 });
  });

  it('SAFE_DELIVERY_SELECT (admin views) selects no location field', () => {
    for (const key of DELIVERY_LOCATION_KEYS) expect(SAFE_DELIVERY_SELECT).not.toHaveProperty(key);
  });

  const order = (delivery: object) => ({ id: 'o1', customerId: 'c1', items: [], payment: null, delivery });
  const delivery = {
    id: 'd1',
    status: 'EN_ROUTE_TO_CUSTOMER',
    deliveryCodeHash: 'h',
    deliveryCodeEncrypted: null,
    deliveryCodeAttempts: 1,
    deliveryCodeLockedUntil: null,
    deliveryCodeUsed: false,
    ...LOCATION,
  };

  const ordersWith = (prisma: any) =>
    new OrdersService(prisma, {} as any, {} as any, { emit: jest.fn() } as any, { get: jest.fn() } as any, {} as any);

  it("the customer's order list has no rider position or coordinates", async () => {
    const svc = ordersWith({ order: { findMany: jest.fn().mockResolvedValue([order(delivery)]) } });
    const out = await svc.findMyOrders('c1');
    expectNoLocation(out);
    for (const secret of ['deliveryCodeHash', 'deliveryCodeEncrypted', 'deliveryCodeAttempts', 'deliveryCodeLockedUntil']) {
      expect(out[0].delivery).not.toHaveProperty(secret);
    }
    expect(out[0].delivery).toMatchObject({ id: 'd1', status: 'EN_ROUTE_TO_CUSTOMER' });
  });

  it("one order (the old tracking screen's source) has none either", async () => {
    const svc = ordersWith({ order: { findFirst: jest.fn().mockResolvedValue(order(delivery)) } });
    const out: any = await svc.findOne('o1', 'c1');
    expectNoLocation(out);
    expect(out.delivery).toMatchObject({ id: 'd1', deliveryCodeUsed: false });
  });
});
