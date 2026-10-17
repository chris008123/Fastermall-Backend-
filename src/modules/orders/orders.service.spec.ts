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
  const svc = new OrdersService(prisma, {} as any, food as any, events as any, config as any);
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
      reserveStock: jest.fn(),
      releaseStock: jest.fn(),
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

describe('OrdersService stock handling', () => {
  const product = { id: 'p1', price: 20, stock: 100, name: 'P' };

  function marketplaceSetup() {
    const s = setup([], '0', 5);
    const marketplace = {
      getProductsByIds: jest.fn().mockResolvedValue([product]),
      reserveStock: jest.fn().mockResolvedValue(undefined),
      releaseStock: jest.fn().mockResolvedValue(undefined),
    };
    (s.svc as any).marketplace = marketplace;
    return { ...s, marketplace };
  }

  it('merges duplicate lines so the stock check sees the real total', async () => {
    const { svc, marketplace } = marketplaceSetup();
    await expect(
      svc.createOrder('u1', {
        type: 'MARKETPLACE',
        items: [
          { productId: 'p1', quantity: 60 },
          { productId: 'p1', quantity: 60 },
        ],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException); // 120 > MAX_LINE_QUANTITY and > stock
    expect(marketplace.reserveStock).not.toHaveBeenCalled();
  });

  it('reserves the merged quantity once', async () => {
    const { svc, marketplace, created } = marketplaceSetup();
    await svc.createOrder('u1', {
      type: 'MARKETPLACE',
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p1', quantity: 3 },
      ],
    } as any);
    expect(marketplace.reserveStock).toHaveBeenCalledWith([{ productId: 'p1', quantity: 5 }]);
    expect(created[0].totalAmount).toBe(105); // 5 x 20 + 5 delivery
  });

  it('gives the stock back and cancels the order row if creating the delivery fails', async () => {
    const { svc, prisma, marketplace } = marketplaceSetup();
    prisma.delivery.create.mockRejectedValue(new Error('db down'));
    prisma.order.updateMany = jest.fn().mockResolvedValue({ count: 1 });

    await expect(
      svc.createOrder('u1', { type: 'MARKETPLACE', items: [{ productId: 'p1', quantity: 2 }] } as any),
    ).rejects.toThrow('db down');

    expect(marketplace.releaseStock).toHaveBeenCalledWith([{ productId: 'p1', quantity: 2 }]);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { status: 'CANCELLED' },
    });
  });

  it('does not reserve stock when the reservation itself is refused', async () => {
    const { svc, prisma, marketplace } = marketplaceSetup();
    marketplace.reserveStock.mockRejectedValue(new BadRequestException('Insufficient stock'));
    await expect(
      svc.createOrder('u1', { type: 'MARKETPLACE', items: [{ productId: 'p1', quantity: 1 }] } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});

describe('OrdersService cancel and expiry restock', () => {
  function txSetup(flipCount: number) {
    const tx: any = {
      order: { updateMany: jest.fn().mockResolvedValue({ count: flipCount }) },
      delivery: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      product: { update: jest.fn() },
    };
    const prisma: any = {
      order: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn().mockResolvedValue({ id: 'o1' }) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const events = { emit: jest.fn() };
    const config = { get: jest.fn() };
    const svc = new OrdersService(prisma, {} as any, {} as any, events as any, config as any);
    return { svc, prisma, tx };
  }

  const order = {
    id: 'o1',
    type: 'MARKETPLACE',
    status: 'PENDING',
    items: [{ productId: 'p1', quantity: 3 }],
  };

  it('puts stock back once when an order is cancelled', async () => {
    const { svc, prisma, tx } = txSetup(1);
    prisma.order.findUnique.mockResolvedValue(order);
    await svc.updateStatus('o1', { status: 'CANCELLED' } as any);
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { stock: { increment: 3 } },
    });
  });

  it('does not restock again if the order was already cancelled', async () => {
    const { svc, prisma, tx } = txSetup(0);
    prisma.order.findUnique.mockResolvedValue({ ...order, status: 'CANCELLED' });
    await svc.updateStatus('o1', { status: 'CANCELLED' } as any);
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('expires stale unpaid orders and restocks them', async () => {
    const { svc, prisma, tx } = txSetup(1);
    prisma.order.findMany.mockResolvedValue([order]);
    const n = await svc.expireUnpaidOrders();
    expect(n).toBe(1);
    expect(tx.product.update).toHaveBeenCalledTimes(1);
  });

  it('never selects cash or paid orders for expiry', async () => {
    const { svc, prisma } = txSetup(1);
    prisma.order.findMany.mockResolvedValue([]);
    await svc.expireUnpaidOrders();
    const json = JSON.stringify(prisma.order.findMany.mock.calls[0][0].where);
    expect(json).toContain('"method":{"not":"CASH"}');
    expect(json).toContain('"status":{"not":"SUCCESSFUL"}');
  });
});
