import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

process.env.DELIVERY_CODE_ENCRYPTION_KEY = '0'.repeat(64);

function setup(menuItems: any[], vendorFee: any = '7.50') {
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
  const svc = new OrdersService(prisma, {} as any, food as any, events as any);
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
