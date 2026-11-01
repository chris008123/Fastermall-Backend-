import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProfileService, VEHICLE_CHANGED_REASON } from './profile.service';

describe('ProfileService', () => {
  let svc: ProfileService;
  let prisma: any;
  let staff: any;
  const moto = { id: 'p1', type: 'MOTORCYCLE', vehiclePlate: 'GR-1234-20', staffUser: { phone: '0200000000' } };

  beforeEach(() => {
    prisma = {
      deliveryPartnerProfile: { findUnique: jest.fn().mockResolvedValue(moto), update: jest.fn().mockResolvedValue({}) },
      delivery: { count: jest.fn().mockResolvedValue(0) },
      partnerDocument: {
        findMany: jest.fn().mockResolvedValue([{ id: 'd1', type: 'VEHICLE_REGISTRATION' }, { id: 'd2', type: 'INSURANCE' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      staffUser: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
    };
    staff = { assertCurrentPassword: jest.fn().mockResolvedValue(undefined) };
    svc = new ProfileService(prisma, staff);
  });

  it('does nothing when no profile field is sent (the online switch alone)', async () => {
    await expect(svc.update('s1', { isAvailable: true })).resolves.toBeNull();
    expect(prisma.deliveryPartnerProfile.findUnique).not.toHaveBeenCalled();
  });

  describe('plate and vehicle type', () => {
    it('saves a new plate in capitals and sends the old vehicle papers back for re-upload', async () => {
      const out: any = await svc.update('s1', { vehiclePlate: ' gr 9999 21 ' });
      expect(prisma.deliveryPartnerProfile.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { type: 'MOTORCYCLE', vehiclePlate: 'GR 9999 21' } });
      expect(prisma.partnerDocument.findMany.mock.calls[0][0].where).toMatchObject({ partnerId: 'p1', status: 'APPROVED' });
      expect(prisma.partnerDocument.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['d1', 'd2'] } },
        data: { status: 'REJECTED', rejectionReason: VEHICLE_CHANGED_REASON, reviewedAt: expect.any(Date) },
      });
      expect(out).toEqual({ changed: ['vehicle'], reverification: { required: true, documentsReset: ['VEHICLE_REGISTRATION', 'INSURANCE'] } });
    });

    it('never touches the driver licence or ID', async () => {
      await svc.update('s1', { vehiclePlate: 'GR-1-22' });
      const types = prisma.partnerDocument.findMany.mock.calls[0][0].where.type.in;
      expect(types).toEqual(['VEHICLE_REGISTRATION', 'INSURANCE']);
    });

    it('sending the same plate changes nothing and needs no re-verification', async () => {
      const out: any = await svc.update('s1', { vehiclePlate: 'gr-1234-20' });
      expect(out).toEqual({ changed: [], reverification: { required: false, documentsReset: [] } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('walking -> motorcycle needs a plate', async () => {
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ ...moto, type: 'WALKING', vehiclePlate: null });
      const err: any = await svc.update('s1', { vehicleType: 'MOTORCYCLE' as any }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe('PLATE_REQUIRED');
      await expect(svc.update('s1', { vehicleType: 'MOTORCYCLE' as any, vehiclePlate: 'GR-5-22' })).resolves.toMatchObject({ changed: ['vehicle'] });
    });

    it('motorcycle -> walking clears the plate, and a plate with walking is refused', async () => {
      await svc.update('s1', { vehicleType: 'WALKING' as any });
      expect(prisma.deliveryPartnerProfile.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { type: 'WALKING', vehiclePlate: null } });
      const err: any = await svc.update('s1', { vehicleType: 'WALKING' as any, vehiclePlate: 'GR-1-22' }).catch((e) => e);
      expect(err.getResponse().code).toBe('VEHICLE_PLATE_NOT_ALLOWED');
    });

    it('is blocked while a delivery is running', async () => {
      prisma.delivery.count.mockResolvedValue(1);
      const err: any = await svc.update('s1', { vehiclePlate: 'GR-1-22' }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('ACTIVE_DELIVERIES');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s for an account with no partner profile', async () => {
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(null);
      await expect(svc.update('x', { vehiclePlate: 'GR-1-22' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('phone', () => {
    it('needs the password, and checks it', async () => {
      const err: any = await svc.update('s1', { phone: '0241112222' }).catch((e) => e);
      expect(err.getResponse().code).toBe('PASSWORD_REQUIRED');
      expect(prisma.staffUser.update).not.toHaveBeenCalled();

      const out: any = await svc.update('s1', { phone: '0241112222', currentPassword: 'pw' });
      expect(staff.assertCurrentPassword).toHaveBeenCalledWith('s1', 'pw');
      expect(prisma.staffUser.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { phone: '0241112222' } });
      expect(out).toEqual({ changed: ['phone'], reverification: { required: false, documentsReset: [] } });
      expect(prisma.partnerDocument.updateMany).not.toHaveBeenCalled();
    });

    it('saves nothing when the password is wrong', async () => {
      staff.assertCurrentPassword.mockRejectedValue(new BadRequestException('no'));
      await expect(svc.update('s1', { phone: '0241112222', currentPassword: 'bad' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('409s when the number belongs to someone else, and then no vehicle change is saved either', async () => {
      prisma.$transaction.mockRejectedValue({ code: 'P2002' });
      const err: any = await svc.update('s1', { phone: '0241112222', currentPassword: 'pw', vehiclePlate: 'GR-7-22' }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('PHONE_IN_USE');
    });

    it('the same number again is a no-op without a password', async () => {
      await expect(svc.update('s1', { phone: '0200000000' })).resolves.toMatchObject({ changed: [] });
    });
  });
});
