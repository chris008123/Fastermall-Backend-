import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { FoodService } from '../food/food.service';

process.env.DELIVERY_CODE_ENCRYPTION_KEY = '0'.repeat(64);

// Gɔbɛ from the requirement: base GH₵0; beans GH₵5/GH₵7 (required),
// plantain GH₵5/GH₵6 (optional), extras sausage GH₵3.50 / egg GH₵2.
const gobe = {
  id: 'gobe', vendorId: 'v1', name: 'Gɔbɛ', price: '0.00', isAvailable: true,
  optionGroups: [
    { id: 'beans', name: 'Beans portion', minSelect: 1, maxSelect: 1, sortOrder: 0, options: [
      { id: 'beans5', name: 'Beans (GH₵5)', price: '5.00', maxQuantity: 1, isAvailable: true, sortOrder: 0 },
      { id: 'beans7', name: 'Beans (GH₵7)', price: '7.00', maxQuantity: 1, isAvailable: true, sortOrder: 1 },
    ] },
    { id: 'plantain', name: 'Plantain', minSelect: 0, maxSelect: 1, sortOrder: 1, options: [
      { id: 'plantain5', name: 'Plantain (GH₵5)', price: '5.00', maxQuantity: 1, isAvailable: true, sortOrder: 0 },
      { id: 'plantain6', name: 'Plantain (GH₵6)', price: '6.00', maxQuantity: 1, isAvailable: true, sortOrder: 1 },
    ] },
    { id: 'extras', name: 'Extras', minSelect: 0, maxSelect: 2, sortOrder: 2, options: [
      { id: 'sausage', name: 'Sausage', price: '3.50', maxQuantity: 2, isAvailable: true, sortOrder: 0 },
      { id: 'egg', name: 'Egg', price: '2.00', maxQuantity: 3, isAvailable: true, sortOrder: 1 },
    ] },
  ],
};
const water = { id: 'water', vendorId: 'v1', name: 'Water', price: '2.00', isAvailable: true, optionGroups: [] };

function setup(items: any[] = [gobe, water]) {
  const created: any[] = [];
  const prisma: any = {
    foodVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', deliveryFee: '4.00' }) },
    order: {
      create: jest.fn(async ({ data }) => {
        created.push(data);
        return { id: 'o1', ...data };
      }),
      findUnique: jest.fn().mockResolvedValue({ id: 'o1' }),
    },
    delivery: { create: jest.fn() },
  };
  const food = { getMenuItemsByIds: jest.fn().mockResolvedValue(items) };
  const svc = new OrdersService(prisma, {} as any, food as any, { emit: jest.fn() } as any, { get: jest.fn() } as any, {} as any);
  return { svc, created };
}

const order = (items: any[]) => ({ type: 'FOOD', items }) as any;

describe('customised food orders', () => {
  it('prices each customer’s Gɔbɛ from the menu and stores what they chose', async () => {
    const { svc, created } = setup();
    await svc.createOrder('c1', order([
      { menuItemId: 'gobe', quantity: 1, options: [{ optionId: 'beans5' }, { optionId: 'plantain5' }, { optionId: 'sausage' }] },
      { menuItemId: 'gobe', quantity: 2, options: [{ optionId: 'beans7' }, { optionId: 'plantain6' }, { optionId: 'egg' }] },
    ]));
    const lines = created[0].items.create;
    expect(lines).toHaveLength(2); // different choices stay separate lines
    expect(lines[0]).toMatchObject({ menuItemId: 'gobe', quantity: 1, unitPrice: 13.5 });
    expect(lines[1]).toMatchObject({ menuItemId: 'gobe', quantity: 2, unitPrice: 15 });
    expect(lines[0].selectedOptions.map((o: any) => o.name)).toEqual(['Beans (GH₵5)', 'Plantain (GH₵5)', 'Sausage']);
    expect(created[0].totalAmount).toBe(13.5 + 2 * 15 + 4); // + vendor delivery fee
  });

  it('merges lines only when the item and the choices are the same', async () => {
    const { svc, created } = setup();
    await svc.createOrder('c1', order([
      { menuItemId: 'gobe', quantity: 1, options: [{ optionId: 'beans5' }, { optionId: 'egg' }] },
      { menuItemId: 'gobe', quantity: 2, options: [{ optionId: 'egg', quantity: 1 }, { optionId: 'beans5' }] },
    ]));
    expect(created[0].items.create).toEqual([expect.objectContaining({ quantity: 3, unitPrice: 7 })]);
  });

  it('plain items are unchanged and store no options', async () => {
    const { svc, created } = setup();
    await svc.createOrder('c1', order([{ menuItemId: 'water', quantity: 3 }]));
    expect(created[0].items.create[0]).toEqual({ menuItemId: 'water', quantity: 3, unitPrice: 2 });
  });

  it('refuses a missing required choice or a bad option before saving anything', async () => {
    const { svc, created } = setup();
    await expect(svc.createOrder('c1', order([{ menuItemId: 'gobe', quantity: 1 }]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createOrder('c1', order([{ menuItemId: 'gobe', quantity: 1, options: [{ optionId: 'beans5' }, { optionId: 'egg', quantity: 9 }] }]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createOrder('c1', order([{ menuItemId: 'water', quantity: 1, options: [{ optionId: 'beans5' }] }]))).rejects.toBeInstanceOf(BadRequestException);
    expect(created).toHaveLength(0);
  });

  it('marketplace products take no options', async () => {
    const { svc } = setup();
    await expect(svc.createOrder('c1', { type: 'MARKETPLACE', items: [{ productId: 'p1', quantity: 1, options: [{ optionId: 'x' }] }] } as any))
      .rejects.toThrow('Marketplace products have no options');
  });

  it('the request body checks the choices’ shape', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CreateOrderDto });
    await expect(check(order([{ menuItemId: 'gobe', quantity: 1, options: [{ optionId: 'beans5', quantity: 2 }] }]))).resolves.toBeDefined();
    await expect(check(order([{ menuItemId: 'gobe', quantity: 1, options: [{ optionId: 'beans5', quantity: 0 }] }]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(check(order([{ menuItemId: 'gobe', quantity: 1, options: [{ id: 'beans5' }] }]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(check(order([{ menuItemId: 'gobe', quantity: 1, options: [{ optionId: 'beans5', price: 0 }] }]))).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('managing options (admin, or the vendor who owns the menu)', () => {
  function food(vendorOwner: string | null = 'vendorStaff1') {
    const prisma: any = {
      foodVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerStaffId: vendorOwner }) },
      menuItem: { findUnique: jest.fn().mockResolvedValue({ vendorId: 'v1' }) },
      menuItemOptionGroup: {
        create: jest.fn(({ data }) => Promise.resolve({ id: 'g1', ...data, options: [] })),
        findUnique: jest.fn().mockResolvedValue({ id: 'g1', menuItemId: 'gobe', minSelect: 0, maxSelect: 1, menuItem: { vendorId: 'v1' } }),
        update: jest.fn(({ data }) => Promise.resolve({ id: 'g1', ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      menuItemOption: {
        create: jest.fn(({ data }) => Promise.resolve({ id: 'opt1', ...data })),
        findUnique: jest.fn().mockResolvedValue({ id: 'opt1', group: { menuItem: { vendorId: 'v1' } } }),
        update: jest.fn(({ data }) => Promise.resolve({ id: 'opt1', ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    return { svc: new FoodService(prisma), prisma };
  }
  const admin = { userId: 'a1', role: 'ADMIN' };
  const owner = { userId: 'vendorStaff1', role: 'VENDOR' };
  const otherVendor = { userId: 'vendorStaff2', role: 'VENDOR' };

  it('the owner (or an admin) builds the Gɔbɛ choices', async () => {
    const { svc, prisma } = food();
    await svc.createOptionGroup(owner, 'gobe', { name: 'Beans portion', minSelect: 1, maxSelect: 1 });
    expect(prisma.menuItemOptionGroup.create.mock.calls[0][0].data).toEqual({ menuItemId: 'gobe', name: 'Beans portion', minSelect: 1, maxSelect: 1, sortOrder: 0 });
    await svc.createOption(admin, 'g1', { name: 'Egg', price: 2, maxQuantity: 3 });
    expect(prisma.menuItemOption.create.mock.calls[0][0].data).toMatchObject({ groupId: 'g1', name: 'Egg', price: 2, maxQuantity: 3, isAvailable: true });
    await svc.updateOption(owner, 'opt1', { isAvailable: false }); // eggs ran out
    expect(prisma.menuItemOption.update.mock.calls[0][0].data).toEqual({ isAvailable: false });
  });

  it('another vendor cannot touch this menu', async () => {
    const { svc, prisma } = food();
    await expect(svc.createOptionGroup(otherVendor, 'gobe', { name: 'X' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.updateOption(otherVendor, 'opt1', { price: 0 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.deleteOptionGroup(otherVendor, 'g1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.menuItemOptionGroup.create).not.toHaveBeenCalled();
    expect(prisma.menuItemOption.update).not.toHaveBeenCalled();
    expect(prisma.menuItemOptionGroup.delete).not.toHaveBeenCalled();
  });

  it('min cannot exceed max; unknown ids 404', async () => {
    const { svc, prisma } = food();
    await expect(svc.createOptionGroup(admin, 'gobe', { name: 'X', minSelect: 3, maxSelect: 2 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.updateOptionGroup(admin, 'g1', { minSelect: 2 })).rejects.toBeInstanceOf(BadRequestException); // stored max is 1
    prisma.menuItem.findUnique.mockResolvedValue(null);
    await expect(svc.createOptionGroup(admin, 'nope', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    prisma.menuItemOption.findUnique.mockResolvedValue(null);
    await expect(svc.deleteOption(admin, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a required group defaults to max = min', async () => {
    const { svc, prisma } = food();
    await svc.createOptionGroup(admin, 'gobe', { name: 'Sides', minSelect: 2 });
    expect(prisma.menuItemOptionGroup.create.mock.calls[0][0].data).toMatchObject({ minSelect: 2, maxSelect: 2 });
  });
});
