import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LaundryService } from '../../modules/laundry/laundry.service';
import { OrdersService } from '../../modules/orders/orders.service';
import { isUniqueViolation, parseIdempotencyKey } from './idempotency';

process.env.DELIVERY_CODE_ENCRYPTION_KEY = '0'.repeat(64);

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: 'x' });

describe('parseIdempotencyKey', () => {
  it('treats a missing or blank header as none', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey('   ')).toBeUndefined();
  });

  it('trims the key and rejects very long ones', () => {
    expect(parseIdempotencyKey(' abc ')).toBe('abc');
    expect(() => parseIdempotencyKey('x'.repeat(256))).toThrow(BadRequestException);
  });

  it('recognises a unique-constraint error', () => {
    expect(isUniqueViolation(p2002())).toBe(true);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
  });
});

describe('POST /laundry/orders', () => {
  const catalog = [{ id: 'c1', name: 'Shirt', unitPrice: 4, vendorId: 'fastermall-laundry' }];
  const dto = { items: [{ catalogItemId: 'c1', quantity: 2 }], addressLabel: 'Unity Hall, Room 12' } as any;

  function setup() {
    const prisma: any = {
      laundryCatalogItem: { findMany: jest.fn().mockResolvedValue(catalog) },
      laundryVendor: { findUnique: jest.fn().mockResolvedValue({ status: 'APPROVED', isOpen: true, name: 'Fastermall Laundry' }) },
      laundryOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => ({ id: 'l1', ...data })),
      },
    };
    const events = { emit: jest.fn() };
    return { svc: new LaundryService(prisma, events as any, {} as any), prisma, events };
  }

  it('saves the pickup address and the key', async () => {
    const { svc, prisma } = setup();
    await svc.createOrder('u1', dto, 'key-1');
    expect(prisma.laundryOrder.create.mock.calls[0][0].data).toMatchObject({
      addressLabel: 'Unity Hall, Room 12',
      idempotencyKey: 'key-1',
    });
  });

  it('returns the first order when the same key is sent again', async () => {
    const { svc, prisma, events } = setup();
    prisma.laundryOrder.findUnique.mockResolvedValue({ id: 'first' });
    await expect(svc.createOrder('u1', dto, 'key-1')).resolves.toEqual({ id: 'first' });
    expect(prisma.laundryOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId_idempotencyKey: { customerId: 'u1', idempotencyKey: 'key-1' } } }),
    );
    expect(prisma.laundryOrder.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('returns the winner when two retries race', async () => {
    const { svc, prisma, events } = setup();
    prisma.laundryOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' });
    prisma.laundryOrder.create.mockRejectedValue(p2002());
    await expect(svc.createOrder('u1', dto, 'key-1')).resolves.toEqual({ id: 'winner' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('works without a key, as before', async () => {
    const { svc, prisma } = setup();
    await svc.createOrder('u1', dto);
    expect(prisma.laundryOrder.findUnique).not.toHaveBeenCalled();
    expect(prisma.laundryOrder.create).toHaveBeenCalled();
  });
});

describe('POST /orders', () => {
  const menuItems = [{ id: 'm1', vendorId: 'v1', name: 'Jollof', price: 10, isAvailable: true }];
  const dto = { type: 'FOOD', items: [{ menuItemId: 'm1', quantity: 1 }] } as any;

  function setup() {
    const prisma: any = {
      foodVendor: { findUnique: jest.fn().mockResolvedValue({ deliveryFee: 5 }) },
      order: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ id: 'first', delivery: null }),
        create: jest.fn(async ({ data }) => ({ id: 'o1', ...data })),
      },
      delivery: { create: jest.fn().mockResolvedValue({ id: 'd1' }) },
    };
    const food = { getMenuItemsByIds: jest.fn().mockResolvedValue(menuItems) };
    const events = { emit: jest.fn() };
    const svc = new OrdersService(prisma, {} as any, food as any, events as any, { get: jest.fn() } as any, {} as any);
    return { svc, prisma, events };
  }

  it('returns the first order when the same key is sent again', async () => {
    const { svc, prisma, events } = setup();
    prisma.order.findUnique.mockResolvedValueOnce({ id: 'first' });
    await expect(svc.createOrder('u1', dto, 'key-1')).resolves.toMatchObject({ id: 'first' });
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.delivery.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('stores the key on a new order', async () => {
    const { svc, prisma } = setup();
    await svc.createOrder('u1', dto, 'key-2');
    expect(prisma.order.create.mock.calls[0][0].data.idempotencyKey).toBe('key-2');
  });

  it('on a race, returns the winner without creating a delivery', async () => {
    const { svc, prisma, events } = setup();
    prisma.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'first' });
    prisma.order.create.mockRejectedValue(p2002());
    await expect(svc.createOrder('u1', dto, 'key-1')).resolves.toMatchObject({ id: 'first' });
    expect(prisma.delivery.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
