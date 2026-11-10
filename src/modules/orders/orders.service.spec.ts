import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

process.env.DELIVERY_CODE_ENCRYPTION_KEY = '0'.repeat(64);

function setup(menuItems: any[], vendorFee: any = '7.50', marketplaceFee = 5) {
  const created: any[] = [];
  const prisma: any = {
    foodVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', deliveryFee: vendorFee }) },
    order: {
      create: jest.fn(async ({ data }) => {
        created.push(data);
        return { id: 'o1', ...data };
      }),
      findUnique: jest.fn().mockResolvedValue({ id: 'o1' }),
    },
    delivery: { create: jest.fn() },
  };
  const food = { getMenuItemsByIds: jest.fn().mockResolvedValue(menuItems) };
  const events = { emit: jest.fn() };
  const config = { get: jest.fn((k: string) => (k === 'orders.marketplaceDeliveryFee' ? marketplaceFee : undefined)) };
  const svc = new OrdersService(prisma, {} as any, food as any, events as any, config as any, {} as any);
  return { svc, prisma, created };
}

const item = (id: string, vendorId: string, price = 10) => ({ id, vendorId, name: id, price, isAvailable: true });
const dto = (extra: any = {}) => ({
  type: 'FOOD',
  items: [{ menuItemId: 'm1', quantity: 2 }],
  ...extra,
}) as any;

describe('OrdersService food delivery fee', () => {
  it('uses the vendor fee and ignores the fee the app sends', async () => {
    const { svc, created } = setup([item('m1', 'v1', 10)]);

    await svc.createOrder('u1', dto({ deliveryFee: 0 }));

    expect(created[0].deliveryFee).toBe(7.5);
    expect(created[0].totalAmount).toBe(27.5); // 2 x 10 + 7.50
  });

  it('cannot be lowered or inflated by the client', async () => {
    const { svc, created } = setup([item('m1', 'v1', 10)]);
    await svc.createOrder('u1', dto({ deliveryFee: 999 }));
    expect(created[0].deliveryFee).toBe(7.5);
  });

  it('rejects a food order that mixes vendors', async () => {
    const { svc } = setup([item('m1', 'v1'), item('m2', 'v2')]);
    await expect(
      svc.createOrder('u1', dto({ items: [{ menuItemId: 'm1', quantity: 1 }, { menuItemId: 'm2', quantity: 1 }] })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OrdersService marketplace delivery fee', () => {
  it('adds the configured flat fee and ignores the one the client sends', async () => {
    const { svc, created } = setup([], '0', 5);
    (svc as any).marketplace = {
      getProductsByIds: jest.fn().mockResolvedValue([{ id: 'p1', price: 20, stock: 9, name: 'P' }]),
      decrementStock: jest.fn(),
    };

    await svc.createOrder('u1', { type: 'MARKETPLACE', items: [{ productId: 'p1', quantity: 1 }], deliveryFee: 0 } as any);

    expect(created).toHaveLength(1);
    expect(created[0].deliveryFee).toBe(5);
    expect(created[0].totalAmount).toBe(25);
  });
});

describe('OrdersService.findMyOrders', () => {
  it('never returns the delivery code hash or encrypted code in the list', async () => {
    const { svc, prisma } = setup([]);
    prisma.order.findMany = jest.fn().mockResolvedValue([
      { id: 'o1', delivery: { id: 'd1', status: 'ASSIGNED', deliveryCodeHash: 'h', deliveryCodeEncrypted: 'e' } },
      { id: 'o2', delivery: null },
    ]);

    const out = await svc.findMyOrders('u1');

    expect(out[0].delivery).toEqual({ id: 'd1', status: 'ASSIGNED' });
    expect(JSON.stringify(out)).not.toMatch(/deliveryCodeHash|deliveryCodeEncrypted/);
    expect(out[1].delivery).toBeNull();
  });
});

describe('OrdersService.findOne delivery code', () => {
  const order = (delivery: any) => ({ id: 'o1', customerId: 'u1', delivery });

  it('returns the decrypted code without the stored secrets', async () => {
    const { encryptDeliveryCode } = jest.requireActual('../../shared/utils/delivery-code-encryption');
    const { svc, prisma } = setup([]);
    prisma.order.findFirst = jest.fn().mockResolvedValue(
      order({ id: 'd1', deliveryCodeHash: 'h', deliveryCodeEncrypted: encryptDeliveryCode('123456'), deliveryCodeUsed: false }),
    );

    const out: any = await svc.findOne('o1', 'u1');

    expect(out.delivery.code).toBe('123456');
    expect(JSON.stringify(out)).not.toMatch(/deliveryCodeHash|deliveryCodeEncrypted/);
  });

  it('issues a fresh code instead of failing when the stored one cannot be decrypted', async () => {
    const { svc, prisma } = setup([]);
    // Encrypted under a different key: valid format, wrong auth tag.
    const foreign = `${'a'.repeat(24)}:${'b'.repeat(32)}:${'c'.repeat(12)}`;
    prisma.order.findFirst = jest.fn().mockResolvedValue(
      order({ id: 'd1', deliveryCodeHash: 'h', deliveryCodeEncrypted: foreign, deliveryCodeUsed: false }),
    );
    prisma.delivery.update = jest.fn().mockResolvedValue({});

    const out: any = await svc.findOne('o1', 'u1');

    expect(out.delivery.code).toMatch(/^\d{6}$/);
    const { data } = prisma.delivery.update.mock.calls[0][0];
    expect(data.deliveryCodeEncrypted).not.toBe(foreign);
    expect(await require('bcrypt').compare(out.delivery.code, data.deliveryCodeHash)).toBe(true);
  });

  it('leaves the code out when an unreadable code was already used', async () => {
    const { svc, prisma } = setup([]);
    prisma.order.findFirst = jest.fn().mockResolvedValue(
      order({ id: 'd1', deliveryCodeHash: 'h', deliveryCodeEncrypted: 'x:y:z', deliveryCodeUsed: true }),
    );
    prisma.delivery.update = jest.fn();

    const out: any = await svc.findOne('o1', 'u1');

    expect(out.delivery.code).toBeUndefined();
    expect(prisma.delivery.update).not.toHaveBeenCalled();
  });
});

describe('OrdersService maintenance mode', () => {
  it('refuses new orders while maintenance mode is on', async () => {
    const { ServiceUnavailableException } = require('@nestjs/common');
    const { OrdersService } = require('./orders.service');
    const prisma: any = { order: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() } };
    const settings = { assertOrderingOpen: jest.fn().mockRejectedValue(new ServiceUnavailableException('Back soon')), get: jest.fn() };
    const svc = new OrdersService(prisma, {} as any, {} as any, { emit: jest.fn() } as any, { get: jest.fn() } as any, {} as any, settings as any);
    await expect(svc.createOrder('c1', { type: 'MARKETPLACE', items: [{ productId: 'p', quantity: 1 }] } as any)).rejects.toThrow('Back soon');
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});

describe('OrdersService payment method (cash removed)', () => {
  it.each(['CASH', 'cash', 'Cash on delivery', ' cash '])('refuses %p before saving anything', async (paymentMethod) => {
    const { svc, prisma } = setup([item('m1', 'v1', 10)]);
    await expect(svc.createOrder('u1', dto({ paymentMethod }))).rejects.toThrow(/no longer available/);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it.each([
    ['mobile_money', 'MOBILE_MONEY'],
    ['Mobile Money', 'MOBILE_MONEY'],
    ['card', 'CARD'],
    ['MoMo', 'MoMo'],
    [undefined, undefined],
    ['  ', undefined],
  ])('stores %p as %p', async (paymentMethod, stored) => {
    const { svc, created } = setup([item('m1', 'v1', 10)]);
    await svc.createOrder('u1', dto({ paymentMethod }));
    expect(created[0].paymentMethod).toBe(stored);
  });
});
