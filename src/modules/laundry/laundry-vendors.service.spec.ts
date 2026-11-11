import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import { LaundryVendorsService } from './laundry-vendors.service';
import { AdminLaundryVendorsController, LaundryVendorsController } from './laundry-vendors.controller';
import { CreateLaundryVendorDto, UpsertLaundryReviewDto } from './dto/laundry-vendor.dto';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';

function setup() {
  const prisma: any = {
    laundryVendor: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 'kleen', catalogItems: [{ id: 'shirt' }] }),
      findUnique: jest.fn().mockResolvedValue({ id: 'kleen' }),
      create: jest.fn(({ data }) => Promise.resolve({ id: 'new', ...data })),
      update: jest.fn(({ data }) => Promise.resolve({ id: 'kleen', ...data })),
    },
    laundryVendorReview: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn(({ create }) => Promise.resolve({ id: 'r1', ...create, createdAt: new Date(), updatedAt: new Date(), user: { fullName: 'Ama Mensah', deletedAt: null } })),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ vendorId: 'kleen' }),
      delete: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue({ _avg: { rating: 4.333 }, _count: { _all: 3 } }),
    },
    laundryOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'done' }) },
    laundryCatalogItem: {
      create: jest.fn(({ data }) => Promise.resolve({ id: 'svc1', ...data })),
      update: jest.fn(({ data }) => Promise.resolve({ id: 'svc1', ...data })),
    },
    staffUser: {
      findUnique: jest.fn().mockResolvedValue({ role: 'LAUNDRY_STAFF' }),
      update: jest.fn(({ data }) => Promise.resolve({ id: 's1', ...data })),
    },
  };
  return { svc: new LaundryVendorsService(prisma), prisma };
}

describe('customers choosing a vendor', () => {
  it('lists approved vendors only: open first, then best rated; no commission shown', async () => {
    const { svc, prisma } = setup();
    await svc.listApproved();
    const arg = prisma.laundryVendor.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ status: 'APPROVED' });
    expect(arg.orderBy.slice(0, 2)).toEqual([{ isOpen: 'desc' }, { rating: { sort: 'desc', nulls: 'last' } }]);
    expect(arg.select).not.toHaveProperty('commissionRate');
  });

  it('a pending or suspended vendor is "not found" for customers', async () => {
    const { svc, prisma } = setup();
    await svc.getApproved('kleen');
    expect(prisma.laundryVendor.findFirst.mock.calls[0][0].where).toEqual({ id: 'kleen', status: 'APPROVED' });
    prisma.laundryVendor.findFirst.mockResolvedValue(null);
    await expect(svc.getApproved('pending-one')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('reviews and star ratings', () => {
  it('after a completed order: saves the review (first name only) and updates the vendor rating', async () => {
    const { svc, prisma } = setup();
    const out = await svc.upsertReview('kleen', 'c1', { rating: 5, comment: ' Spotless shirts ' });
    expect(prisma.laundryOrder.findFirst.mock.calls[0][0].where).toEqual({ customerId: 'c1', vendorId: 'kleen', status: 'COMPLETED' });
    expect(prisma.laundryVendorReview.upsert.mock.calls[0][0]).toMatchObject({
      where: { vendorId_userId: { vendorId: 'kleen', userId: 'c1' } },
      create: { rating: 5, comment: 'Spotless shirts' },
    });
    expect(out.review.author).toBe('Ama');
    expect(prisma.laundryVendor.update).toHaveBeenCalledWith(expect.objectContaining({ data: { rating: 4.3, reviewCount: 3 } }));
  });

  it('refused without a completed order with that vendor', async () => {
    const { svc, prisma } = setup();
    prisma.laundryOrder.findFirst.mockResolvedValue(null);
    await expect(svc.upsertReview('kleen', 'c1', { rating: 4 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.laundryVendorReview.upsert).not.toHaveBeenCalled();
  });

  it('deleting the last review sets the rating back to null', async () => {
    const { svc, prisma } = setup();
    prisma.laundryVendorReview.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } });
    await svc.removeMyReview('kleen', 'c1');
    expect(prisma.laundryVendor.update).toHaveBeenCalledWith(expect.objectContaining({ data: { rating: null, reviewCount: 0 } }));
    prisma.laundryVendorReview.deleteMany.mockResolvedValue({ count: 0 });
    await expect(svc.removeMyReview('kleen', 'c1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('admins can remove any review (moderation)', async () => {
    const { svc, prisma } = setup();
    await svc.adminRemoveReview('r1');
    expect(prisma.laundryVendorReview.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    prisma.laundryVendorReview.findUnique.mockResolvedValue(null);
    await expect(svc.adminRemoveReview('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('admin: onboarding and catalog', () => {
  it('a new vendor starts PENDING unless approved straight away', async () => {
    const { svc, prisma } = setup();
    await svc.create({ name: 'Kleen Laundry', commissionRate: 12.5 });
    expect(prisma.laundryVendor.create.mock.calls[0][0].data).toMatchObject({ name: 'Kleen Laundry', status: 'PENDING', isOpen: true, commissionRate: 12.5 });
    await svc.create({ name: 'Fresh', status: 'APPROVED' });
    expect(prisma.laundryVendor.create.mock.calls[1][0].data.status).toBe('APPROVED');
    await expect(svc.create({ name: 'Bad', logoUrl: 'http://x/logo.png' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('status changes go through their own route; empty edits are refused', async () => {
    const { svc } = setup();
    await expect(svc.update('kleen', { status: 'APPROVED' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('kleen', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setStatus('kleen', { status: 'SUSPENDED' })).resolves.toMatchObject({ status: 'SUSPENDED' });
  });

  it('adds services with their own prices, to an existing vendor', async () => {
    const { svc, prisma } = setup();
    await svc.addService('kleen', { name: 'Duvet', unitPrice: 30 });
    expect(prisma.laundryCatalogItem.create.mock.calls[0][0].data).toEqual({ vendorId: 'kleen', name: 'Duvet', description: null, unitPrice: 30, isActive: true });
    prisma.laundryVendor.findUnique.mockResolvedValue(null);
    await expect(svc.addService('nope', { name: 'Duvet', unitPrice: 30 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('assigns only LAUNDRY_STAFF to a vendor (null = back to Fastermall)', async () => {
    const { svc, prisma } = setup();
    await svc.assignStaff('s1', 'kleen');
    expect(prisma.staffUser.update.mock.calls[0][0].data).toEqual({ laundryVendorId: 'kleen' });
    await svc.assignStaff('s1', null);
    expect(prisma.staffUser.update.mock.calls[1][0].data).toEqual({ laundryVendorId: null });
    prisma.staffUser.findUnique.mockResolvedValue({ role: 'DELIVERY_PARTNER' });
    await expect(svc.assignStaff('p1', 'kleen')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('validation and routes', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  it('ratings are 1-5; a vendor needs a name; commission 0-100', async () => {
    await expect(pipe.transform({ rating: 6 }, { type: 'body', metatype: UpsertLaundryReviewDto })).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ rating: 4 }, { type: 'body', metatype: UpsertLaundryReviewDto })).resolves.toBeDefined();
    await expect(pipe.transform({ name: 'K' }, { type: 'body', metatype: CreateLaundryVendorDto })).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ name: 'Kleen', commissionRate: 120 }, { type: 'body', metatype: CreateLaundryVendorDto })).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ name: 'Kleen', status: 'SUSPENDED' }, { type: 'body', metatype: CreateLaundryVendorDto })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('customer routes need login; admin routes are ADMIN only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LaundryVendorsController)).toBeDefined();
    expect(new Reflector().get(ROLES_KEY, AdminLaundryVendorsController)).toEqual([StaffRole.ADMIN]);
  });
});
