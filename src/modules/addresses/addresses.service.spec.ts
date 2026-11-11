import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AddressesService, formatAddressLabel } from './addresses.service';
import { OrdersService } from '../orders/orders.service';
import { LaundryService } from '../laundry/laundry.service';

process.env.DELIVERY_CODE_ENCRYPTION_KEY = '0'.repeat(64);

const address = (over: object = {}) => ({
  id: 'a1', userId: 'u1', label: 'Hostel', hostel: 'Unity Hall', room: '12', landmark: null,
  lat: 6.67, lng: -1.57, isDefault: true, ...over,
});

function setup() {
  const tx: any = {
    address: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn(),
      create: jest.fn(async ({ data }) => ({ id: 'new', ...data })),
      update: jest.fn(async ({ data }) => ({ ...address(), ...data })),
      delete: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const prisma: any = {
    address: { findMany: jest.fn(), findFirst: jest.fn().mockResolvedValue(address()) },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  return { svc: new AddressesService(prisma), prisma, tx };
}

const body = { label: 'Hostel', hostel: ' Unity Hall ', room: '12' };

describe('AddressesService', () => {
  it('makes the first address the default and trims text', async () => {
    const { svc, tx } = setup();
    const created = await svc.create('u1', body);
    expect(created).toMatchObject({ userId: 'u1', hostel: 'Unity Hall', isDefault: true });
  });

  it('a later address is not the default unless asked', async () => {
    const { svc, tx } = setup();
    tx.address.count.mockResolvedValue(2);
    await svc.create('u1', body);
    expect(tx.address.create.mock.calls[0][0].data.isDefault).toBe(false);
    expect(tx.address.updateMany).not.toHaveBeenCalled();
  });

  it('choosing a new default clears the old one', async () => {
    const { svc, tx } = setup();
    tx.address.count.mockResolvedValue(2);
    await svc.create('u1', { ...body, isDefault: true });
    expect(tx.address.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', isDefault: true }, data: { isDefault: false } });
    expect(tx.address.create.mock.calls[0][0].data.isDefault).toBe(true);
  });

  it('caps saved addresses at 20', async () => {
    const { svc, tx } = setup();
    tx.address.count.mockResolvedValue(20);
    await expect(svc.create('u1', body)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.address.create).not.toHaveBeenCalled();
  });

  it('needs lat and lng together', async () => {
    const { svc } = setup();
    await expect(svc.create('u1', { ...body, lat: 6.6 })).rejects.toThrow('Send both lat and lng, or neither');
    await expect(svc.update('u1', 'a1', { lng: -1.5 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("hides someone else's address as 'not found'", async () => {
    const { svc, prisma, tx } = setup();
    prisma.address.findFirst.mockResolvedValue(null);
    await expect(svc.update('u2', 'a1', { room: '3' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('u2', 'a1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.address.findFirst).toHaveBeenCalledWith({ where: { id: 'a1', userId: 'u2' } });
    expect(tx.address.delete).not.toHaveBeenCalled();
  });

  it('making an address the default clears the old default', async () => {
    const { svc, prisma, tx } = setup();
    prisma.address.findFirst.mockResolvedValue(address({ isDefault: false }));
    await svc.update('u1', 'a1', { isDefault: true });
    expect(tx.address.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', isDefault: true }, data: { isDefault: false } });
  });

  it('deleting the default hands it to the oldest remaining address', async () => {
    const { svc, tx } = setup();
    tx.address.findFirst.mockResolvedValue({ id: 'a2' });
    await expect(svc.remove('u1', 'a1')).resolves.toEqual({ deleted: true });
    expect(tx.address.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
    expect(tx.address.update).toHaveBeenCalledWith({ where: { id: 'a2' }, data: { isDefault: true } });
  });

  it('formats the label riders see', () => {
    expect(formatAddressLabel(address())).toBe('Unity Hall, Room 12');
    expect(formatAddressLabel(address({ landmark: 'the main gate' }))).toBe('Unity Hall, Room 12, near the main gate');
  });
});

describe('ordering with a saved address', () => {
  it('copies the address onto a food order and its coordinates onto the delivery', async () => {
    const prisma: any = {
      foodVendor: { findUnique: jest.fn().mockResolvedValue({ deliveryFee: 5 }) },
      order: {
        create: jest.fn(async ({ data }) => ({ id: 'o1', ...data })),
        findUnique: jest.fn().mockResolvedValue({ id: 'o1' }),
      },
      delivery: { create: jest.fn().mockResolvedValue({ id: 'd1' }) },
    };
    const food = { getMenuItemsByIds: jest.fn().mockResolvedValue([{ id: 'm1', vendorId: 'v1', name: 'Rice', price: 10, isAvailable: true }]) };
    const addresses = { getOwned: jest.fn().mockResolvedValue(address()) };
    const svc = new OrdersService(prisma, {} as any, food as any, { emit: jest.fn() } as any, { get: jest.fn() } as any, addresses as any);

    await svc.createOrder('u1', { type: 'FOOD', items: [{ menuItemId: 'm1', quantity: 1 }], addressId: 'a1', addressLabel: 'ignored' } as any);

    expect(addresses.getOwned).toHaveBeenCalledWith('u1', 'a1');
    expect(prisma.order.create.mock.calls[0][0].data.addressLabel).toBe('Unity Hall, Room 12');
    expect(prisma.delivery.create.mock.calls[0][0].data).toMatchObject({ dropoffLat: 6.67, dropoffLng: -1.57 });
  });

  it('copies the address onto a laundry order', async () => {
    const prisma: any = {
      laundryCatalogItem: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Shirt', unitPrice: 4, vendorId: 'fastermall-laundry' }]) },
      laundryVendor: { findUnique: jest.fn().mockResolvedValue({ status: 'APPROVED', isOpen: true, name: 'Fastermall Laundry' }) },
      laundryOrder: { create: jest.fn(async ({ data }) => ({ id: 'l1', ...data })) },
    };
    const addresses = { getOwned: jest.fn().mockResolvedValue(address({ landmark: 'the gate' })) };
    const svc = new LaundryService(prisma, { emit: jest.fn() } as any, addresses as any);

    await svc.createOrder('u1', { items: [{ catalogItemId: 'c1', quantity: 1 }], addressId: 'a1' } as any);

    expect(prisma.laundryOrder.create.mock.calls[0][0].data.addressLabel).toBe('Unity Hall, Room 12, near the gate');
  });

  it("an address id that isn't the customer's stops the order", async () => {
    const addresses = { getOwned: jest.fn().mockRejectedValue(new NotFoundException('Address not found')) };
    const prisma: any = { laundryOrder: { create: jest.fn() }, laundryCatalogItem: { findMany: jest.fn() } };
    const svc = new LaundryService(prisma, { emit: jest.fn() } as any, addresses as any);
    await expect(svc.createOrder('u1', { items: [], addressId: 'other' } as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.laundryOrder.create).not.toHaveBeenCalled();
  });
});
