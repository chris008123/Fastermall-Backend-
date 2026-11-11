import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DEFAULT_LAUNDRY_VENDOR_ID, LaundryService } from './laundry.service';

const order = (over: any = {}) => ({ id: 'l1', customerId: 'owner', vendorId: DEFAULT_LAUNDRY_VENDOR_ID, items: [], ...over });

function setup(row: any = order(), staffVendor: string | null = null) {
  const prisma: any = {
    laundryOrder: {
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(({ data }) => Promise.resolve({ ...row, ...data })),
      create: jest.fn(({ data }) => Promise.resolve({ id: 'new', ...data })),
    },
    staffUser: { findUnique: jest.fn().mockResolvedValue({ laundryVendorId: staffVendor }) },
    laundryCatalogItem: { findMany: jest.fn().mockResolvedValue([]) },
    laundryVendor: { findUnique: jest.fn().mockResolvedValue({ status: 'APPROVED', isOpen: true, name: 'Kleen' }) },
  };
  const events = { emit: jest.fn() };
  return { svc: new LaundryService(prisma, events as any, {} as any), prisma, events };
}

describe('LaundryService.findOne: who may see an order', () => {
  it('the owner sees their order; another customer gets "not found"', async () => {
    await expect(setup().svc.findOne('l1', { userId: 'owner', role: 'CUSTOMER' })).resolves.toMatchObject({ id: 'l1' });
    await expect(setup().svc.findOne('l1', { userId: 'someone-else', role: 'CUSTOMER' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('admins see every order', async () => {
    await expect(setup(order({ vendorId: 'kleen' })).svc.findOne('l1', { userId: 'a', role: 'ADMIN' })).resolves.toBeDefined();
  });

  it('laundry staff see only their vendor’s orders (no vendor = Fastermall Laundry)', async () => {
    await expect(setup(order(), null).svc.findOne('l1', { userId: 's', role: 'LAUNDRY_STAFF' })).resolves.toBeDefined();
    await expect(setup(order({ vendorId: null }), null).svc.findOne('l1', { userId: 's', role: 'LAUNDRY_STAFF' })).resolves.toBeDefined();
    await expect(setup(order({ vendorId: 'kleen' }), 'kleen').svc.findOne('l1', { userId: 's', role: 'LAUNDRY_STAFF' })).resolves.toBeDefined();
    await expect(setup(order(), 'kleen').svc.findOne('l1', { userId: 's', role: 'LAUNDRY_STAFF' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup(order({ vendorId: 'kleen' }), null).svc.findOne('l1', { userId: 's', role: 'LAUNDRY_STAFF' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not treat other staff roles as laundry staff', async () => {
    await expect(setup().svc.findOne('l1', { userId: 'v', role: 'VENDOR' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('staff cannot move another vendor’s order', async () => {
    const { svc, prisma } = setup(order({ vendorId: 'kleen' }), null);
    await expect(svc.updateStatus('l1', { status: 'WASHING' } as any, { userId: 's', role: 'LAUNDRY_STAFF' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.laundryOrder.update).not.toHaveBeenCalled();
  });

  it('staff order list: own vendor only; admins any or ?vendorId', async () => {
    const a = setup(order(), 'kleen');
    await a.svc.staffOrders({ userId: 's', role: 'LAUNDRY_STAFF' }, { vendorId: 'other', status: 'WASHING' });
    expect(a.prisma.laundryOrder.findMany.mock.calls[0][0].where).toEqual({ vendorId: 'kleen', status: 'WASHING' });
    const b = setup();
    await b.svc.staffOrders({ userId: 'a', role: 'ADMIN' });
    expect(b.prisma.laundryOrder.findMany.mock.calls[0][0].where).toEqual({});
  });
});

describe('LaundryService catalog and ordering with vendors', () => {
  const item = (id: string, vendorId: string, unitPrice = '10.00') => ({ id, name: id, unitPrice, vendorId, isActive: true });

  it('GET /laundry/catalog without a vendor is Fastermall Laundry (older apps)', async () => {
    const { svc, prisma } = setup();
    await svc.getCatalog();
    expect(prisma.laundryCatalogItem.findMany.mock.calls[0][0].where).toEqual({ isActive: true, vendorId: DEFAULT_LAUNDRY_VENDOR_ID });
    await svc.getCatalog('kleen');
    expect(prisma.laundryCatalogItem.findMany.mock.calls[1][0].where).toEqual({ isActive: true, vendorId: 'kleen' });
  });

  it('an order takes its vendor from the items and records it', async () => {
    const { svc, prisma } = setup();
    prisma.laundryCatalogItem.findMany.mockResolvedValue([item('shirt', 'kleen'), item('duvet', 'kleen', '30.00')]);
    await svc.createOrder('c1', { items: [{ catalogItemId: 'shirt', quantity: 2 }, { catalogItemId: 'duvet', quantity: 1 }] } as any);
    expect(prisma.laundryOrder.create.mock.calls[0][0].data).toMatchObject({ vendorId: 'kleen', laundryTotal: 50 });
  });

  it('refuses mixing vendors, a mismatched vendor, a closed or unapproved vendor', async () => {
    const mixed = setup();
    mixed.prisma.laundryCatalogItem.findMany.mockResolvedValue([item('a', 'kleen'), item('b', 'fresh')]);
    await expect(mixed.svc.createOrder('c1', { items: [{ catalogItemId: 'a', quantity: 1 }, { catalogItemId: 'b', quantity: 1 }] } as any))
      .rejects.toMatchObject({ response: { code: 'MIXED_LAUNDRY_VENDORS' } });

    const wrong = setup();
    wrong.prisma.laundryCatalogItem.findMany.mockResolvedValue([item('a', 'kleen')]);
    await expect(wrong.svc.createOrder('c1', { vendorId: 'fresh', items: [{ catalogItemId: 'a', quantity: 1 }] } as any)).rejects.toBeInstanceOf(BadRequestException);

    const closed = setup();
    closed.prisma.laundryCatalogItem.findMany.mockResolvedValue([item('a', 'kleen')]);
    closed.prisma.laundryVendor.findUnique.mockResolvedValue({ status: 'APPROVED', isOpen: false, name: 'Kleen' });
    await expect(closed.svc.createOrder('c1', { items: [{ catalogItemId: 'a', quantity: 1 }] } as any)).rejects.toBeInstanceOf(ConflictException);

    const suspended = setup();
    suspended.prisma.laundryCatalogItem.findMany.mockResolvedValue([item('a', 'kleen')]);
    suspended.prisma.laundryVendor.findUnique.mockResolvedValue({ status: 'SUSPENDED', isOpen: true, name: 'Kleen' });
    await expect(suspended.svc.createOrder('c1', { items: [{ catalogItemId: 'a', quantity: 1 }] } as any)).rejects.toBeInstanceOf(NotFoundException);

    for (const s of [mixed, wrong, closed, suspended]) expect(s.prisma.laundryOrder.create).not.toHaveBeenCalled();
  });
});
