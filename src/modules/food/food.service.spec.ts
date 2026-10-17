import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FoodService } from './food.service';

function setup() {
  const prisma: any = {
    foodVendor: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    menuItem: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    staffUser: { findUnique: jest.fn() },
  };
  return { svc: new FoodService(prisma), prisma };
}

const vendorA = { userId: 'staff-a', role: 'VENDOR' };
const vendorB = { userId: 'staff-b', role: 'VENDOR' };
const admin = { userId: 'admin-1', role: 'ADMIN' };

describe('FoodService vendor ownership', () => {
  it('lets a vendor edit an item of a vendor they own', async () => {
    const { svc, prisma } = setup();
    prisma.menuItem.findUnique.mockResolvedValue({ vendorId: 'v1' });
    prisma.foodVendor.findUnique.mockResolvedValue({ id: 'v1', ownerStaffId: 'staff-a' });
    prisma.menuItem.update.mockResolvedValue({ id: 'm1' });

    await svc.updateMenuItem(vendorA, 'm1', { price: 12 } as any);
    expect(prisma.menuItem.update).toHaveBeenCalled();
  });

  it("blocks a vendor from editing another vendor's item", async () => {
    const { svc, prisma } = setup();
    prisma.menuItem.findUnique.mockResolvedValue({ vendorId: 'v1' });
    prisma.foodVendor.findUnique.mockResolvedValue({ id: 'v1', ownerStaffId: 'staff-a' });

    await expect(svc.updateMenuItem(vendorB, 'm1', { price: 0 } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.menuItem.update).not.toHaveBeenCalled();
  });

  it('blocks a vendor from editing items of a vendor nobody owns yet', async () => {
    const { svc, prisma } = setup();
    prisma.menuItem.findUnique.mockResolvedValue({ vendorId: 'v1' });
    prisma.foodVendor.findUnique.mockResolvedValue({ id: 'v1', ownerStaffId: null });

    await expect(svc.updateMenuItem(vendorA, 'm1', {} as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("blocks a vendor from adding items under someone else's vendor", async () => {
    const { svc, prisma } = setup();
    prisma.foodVendor.findUnique.mockResolvedValue({ id: 'v1', ownerStaffId: 'staff-a' });

    await expect(
      svc.createMenuItem(vendorB, { vendorId: 'v1', name: 'Free food', price: 0 } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.menuItem.create).not.toHaveBeenCalled();
  });

  it('lets an admin manage any vendor', async () => {
    const { svc, prisma } = setup();
    prisma.foodVendor.findUnique.mockResolvedValue({ id: 'v1', ownerStaffId: 'staff-a' });
    prisma.menuItem.create.mockResolvedValue({ id: 'm1' });

    await svc.createMenuItem(admin, { vendorId: 'v1', name: 'Jollof', price: 10 } as any);
    expect(prisma.menuItem.create).toHaveBeenCalled();
  });

  it('404s for a missing vendor or item', async () => {
    const { svc, prisma } = setup();
    prisma.menuItem.findUnique.mockResolvedValue(null);
    await expect(svc.updateMenuItem(admin, 'nope', {} as any)).rejects.toBeInstanceOf(NotFoundException);

    prisma.foodVendor.findUnique.mockResolvedValue(null);
    await expect(
      svc.createMenuItem(admin, { vendorId: 'nope', name: 'x', price: 1 } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only accepts a VENDOR staff account as owner', async () => {
    const { svc, prisma } = setup();
    prisma.foodVendor.findUnique.mockResolvedValue({ id: 'v1' });
    prisma.staffUser.findUnique.mockResolvedValue({ role: 'DELIVERY_PARTNER' });

    await expect(svc.assignVendorOwner('v1', 'staff-x')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.foodVendor.update).not.toHaveBeenCalled();

    prisma.staffUser.findUnique.mockResolvedValue({ role: 'VENDOR' });
    prisma.foodVendor.update.mockResolvedValue({ id: 'v1' });
    await svc.assignVendorOwner('v1', 'staff-a');
    expect(prisma.foodVendor.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { ownerStaffId: 'staff-a' },
    });
  });
});
