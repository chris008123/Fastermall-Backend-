import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreatePartnerApplicationDto } from './dto/partner-application.dto';
import { ageOn, PartnerApplicationsService } from './partner-applications.service';

const now = new Date('2026-11-12T10:00:00Z');

const dto = (over: Partial<CreatePartnerApplicationDto> = {}): CreatePartnerApplicationDto => ({
  fullName: 'Kojo Mensah',
  email: 'kojo@example.com',
  phone: '0241234567',
  dateOfBirth: '2000-05-14',
  address: 'Ayeduase, Kumasi',
  partnerType: 'MOTORCYCLE',
  plateNumber: 'AS 1234-20',
  ...over,
});

function setup() {
  const tx = {
    partnerApplication: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'app-1', status: 'APPROVED' }),
    },
    staffUser: { create: jest.fn().mockResolvedValue({ id: 'staff-1', email: 'kojo@example.com', fullName: 'Kojo Mensah' }) },
    deliveryPartnerProfile: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    staffUser: { findFirst: jest.fn().mockResolvedValue(null) },
    partnerApplication: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'app-1', status: 'PENDING', createdAt: now, ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'app-1', status: 'REJECTED' }),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const email = { sendPartnerApprovedEmail: jest.fn().mockResolvedValue(undefined) };
  const service = new PartnerApplicationsService(prisma as never, email as never);
  return { service, prisma, tx, email };
}

describe('PartnerApplicationsService.apply', () => {
  it('stores a new application and returns only a receipt', async () => {
    const { service, prisma } = setup();
    const out = await service.apply(dto(), now);
    expect(out).toEqual({ id: 'app-1', status: 'PENDING', createdAt: now });
    expect(prisma.partnerApplication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'kojo@example.com', phone: '0241234567', partnerType: 'MOTORCYCLE', plateNumber: 'AS 1234-20' }),
    });
  });

  it('drops the plate for walking partners', async () => {
    const { service, prisma } = setup();
    await service.apply(dto({ partnerType: 'WALKING', plateNumber: 'X' }), now);
    expect(prisma.partnerApplication.create.mock.calls[0][0].data.plateNumber).toBeNull();
  });

  it('refuses under-18s and impossible dates', async () => {
    const { service } = setup();
    await expect(service.apply(dto({ dateOfBirth: '2010-01-01' }), now)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.apply(dto({ dateOfBirth: '2030-01-01' }), now)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses someone who already has an account or a pending application', async () => {
    const a = setup();
    a.prisma.staffUser.findFirst.mockResolvedValue({ id: 'staff-9' });
    await expect(a.service.apply(dto(), now)).rejects.toMatchObject({ response: { code: 'ACCOUNT_EXISTS' } });

    const b = setup();
    b.prisma.partnerApplication.findFirst.mockResolvedValue({ id: 'app-0' });
    await expect(b.service.apply(dto(), now)).rejects.toMatchObject({ response: { code: 'APPLICATION_PENDING' } });
  });
});

describe('PartnerApplicationsService.approve', () => {
  it('creates the partner account and marks the application approved together', async () => {
    const { service, tx } = setup();
    tx.partnerApplication.findUnique.mockResolvedValue({
      id: 'app-1', status: 'PENDING', email: 'kojo@example.com', phone: '0241234567', fullName: 'Kojo Mensah', partnerType: 'MOTORCYCLE',
    });
    const out = await service.approve('app-1', 'admin-1', 'temporary-pass');
    expect(tx.staffUser.create.mock.calls[0][0].data).toMatchObject({ email: 'kojo@example.com', role: 'DELIVERY_PARTNER' });
    expect(tx.staffUser.create.mock.calls[0][0].data.passwordHash).not.toBe('temporary-pass');
    expect(tx.deliveryPartnerProfile.create).toHaveBeenCalledWith({ data: { staffUserId: 'staff-1', type: 'MOTORCYCLE' } });
    expect(tx.partnerApplication.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'app-1', status: 'PENDING' },
      data: { status: 'APPROVED', reviewedById: 'admin-1', staffUserId: 'staff-1' },
    });
    expect(out.account).toEqual({ id: 'staff-1', email: 'kojo@example.com', fullName: 'Kojo Mensah' });
  });

  it('emails the partner their sign-in, and still approves if the email fails', async () => {
    const pending = { id: 'app-1', status: 'PENDING', email: 'kojo@example.com', phone: '0241234567', fullName: 'Kojo Mensah', partnerType: 'MOTORCYCLE' };
    const a = setup();
    a.tx.partnerApplication.findUnique.mockResolvedValue(pending);
    a.tx.partnerApplication.findUniqueOrThrow.mockResolvedValue({ ...pending, status: 'APPROVED' });
    const ok = await a.service.approve('app-1', 'admin-1', 'temporary-pass');
    expect(a.email.sendPartnerApprovedEmail).toHaveBeenCalledWith('kojo@example.com', {
      fullName: 'Kojo Mensah',
      password: 'temporary-pass',
      motorcycle: true,
    });
    expect(ok.emailSent).toBe(true);

    const b = setup();
    b.tx.partnerApplication.findUnique.mockResolvedValue(pending);
    b.email.sendPartnerApprovedEmail.mockRejectedValue(new Error('SMTP down'));
    const notSent = await b.service.approve('app-1', 'admin-1', 'temporary-pass');
    expect(notSent.emailSent).toBe(false);
    expect(notSent.account.id).toBe('staff-1');
  });

  it('sends no email when the approval itself fails', async () => {
    const { service, tx, email } = setup();
    tx.partnerApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'APPROVED' });
    await expect(service.approve('app-1', 'admin-1', 'temporary-pass')).rejects.toBeInstanceOf(ConflictException);
    expect(email.sendPartnerApprovedEmail).not.toHaveBeenCalled();
  });

  it('refuses an application that was already reviewed, or reviewed at the same moment', async () => {
    const a = setup();
    a.tx.partnerApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'REJECTED' });
    await expect(a.service.approve('app-1', 'admin-1', 'temporary-pass')).rejects.toBeInstanceOf(ConflictException);
    expect(a.tx.staffUser.create).not.toHaveBeenCalled();

    const b = setup();
    b.tx.partnerApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'PENDING', partnerType: 'WALKING' });
    b.tx.partnerApplication.updateMany.mockResolvedValue({ count: 0 });
    await expect(b.service.approve('app-1', 'admin-1', 'temporary-pass')).rejects.toMatchObject({ response: { code: 'APPLICATION_REVIEWED' } });
  });

  it('explains a taken email or phone', async () => {
    const { service, tx } = setup();
    tx.partnerApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'PENDING', partnerType: 'WALKING' });
    tx.staffUser.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(service.approve('app-1', 'admin-1', 'temporary-pass')).rejects.toMatchObject({ response: { code: 'ACCOUNT_EXISTS' } });
  });

  it('is not found for an unknown id', async () => {
    const { service, tx } = setup();
    tx.partnerApplication.findUnique.mockResolvedValue(null);
    await expect(service.approve('nope', 'admin-1', 'temporary-pass')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PartnerApplicationsService.reject', () => {
  it('rejects a pending application with the reason', async () => {
    const { service, prisma } = setup();
    await service.reject('app-1', 'admin-1', 'Licence photo unreadable');
    expect(prisma.partnerApplication.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'app-1', status: 'PENDING' },
      data: { status: 'REJECTED', rejectionReason: 'Licence photo unreadable', reviewedById: 'admin-1' },
    });
  });

  it('says why when it cannot', async () => {
    const { service, prisma } = setup();
    prisma.partnerApplication.updateMany.mockResolvedValue({ count: 0 });
    prisma.partnerApplication.findUnique.mockResolvedValue({ status: 'APPROVED' });
    await expect(service.reject('app-1', 'admin-1', 'late')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ageOn and the request body', () => {
  it('counts birthdays correctly', () => {
    expect(ageOn(new Date('2008-11-12T00:00:00Z'), now)).toBe(18);
    expect(ageOn(new Date('2008-11-13T00:00:00Z'), now)).toBe(17);
  });

  it('normalises phone numbers and needs a plate for motorcycles', () => {
    const ok = plainToInstance(CreatePartnerApplicationDto, { ...dto(), phone: '+233 24 123 4567', email: ' Kojo@Example.com ' });
    expect(validateSync(ok)).toEqual([]);
    expect(ok.phone).toBe('0241234567');
    expect(ok.email).toBe('kojo@example.com');

    const noPlate = plainToInstance(CreatePartnerApplicationDto, { ...dto(), plateNumber: undefined });
    expect(validateSync(noPlate).map((e) => e.property)).toEqual(['plateNumber']);

    const walking = plainToInstance(CreatePartnerApplicationDto, { ...dto(), partnerType: 'WALKING', plateNumber: undefined });
    expect(validateSync(walking)).toEqual([]);
  });
});
