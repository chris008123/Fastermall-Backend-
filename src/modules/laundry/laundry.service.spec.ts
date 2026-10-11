import { NotFoundException } from '@nestjs/common';
import { LaundryService } from './laundry.service';

const order = { id: 'l1', customerId: 'owner', items: [] };

function setup() {
  const prisma = { laundryOrder: { findUnique: jest.fn().mockResolvedValue(order) } };
  return new LaundryService(prisma as any, { emit: jest.fn() } as any);
}

describe('LaundryService.findOne ownership', () => {
  it('lets the owner read their order', async () => {
    await expect(setup().findOne('l1', { userId: 'owner', role: 'CUSTOMER' })).resolves.toMatchObject({ id: 'l1' });
  });

  it("hides another customer's order as 'not found'", async () => {
    await expect(setup().findOne('l1', { userId: 'someone-else', role: 'CUSTOMER' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets laundry staff and admins read any order', async () => {
    await expect(setup().findOne('l1', { userId: 's', role: 'LAUNDRY_STAFF' })).resolves.toBeDefined();
    await expect(setup().findOne('l1', { userId: 'a', role: 'ADMIN' })).resolves.toBeDefined();
  });

  it('does not treat other staff roles as laundry staff', async () => {
    await expect(setup().findOne('l1', { userId: 'v', role: 'VENDOR' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
