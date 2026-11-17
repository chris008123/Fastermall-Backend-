import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LogisticsService } from './logistics.service';
import { partnerVerification } from './documents.service';

// With the partnerDocumentsRequired setting on, a partner must have every
// required document approved (and unexpired) to go online or take a delivery.
const NOW = new Date('2026-11-17T12:00:00Z');
const approved = (type: string, expiresAt: Date | null = null) => ({ type, status: 'APPROVED', expiresAt });

describe('partnerVerification', () => {
  it('walking partners need an ID card and a profile photo', () => {
    expect(partnerVerification('WALKING', [approved('ID_CARD')], NOW)).toMatchObject({ status: 'INCOMPLETE', missing: ['PROFILE_PHOTO'] });
    expect(partnerVerification('WALKING', [approved('ID_CARD'), approved('PROFILE_PHOTO')], NOW).status).toBe('VERIFIED');
  });

  it('motorcycle riders also need licence, registration and insurance, and expired ones do not count', () => {
    const base = [approved('ID_CARD'), approved('PROFILE_PHOTO'), approved('VEHICLE_REGISTRATION', new Date('2027-01-01'))];
    expect(partnerVerification('MOTORCYCLE', base, NOW).missing).toEqual(['DRIVERS_LICENSE', 'INSURANCE']);
    const expired = [...base, approved('DRIVERS_LICENSE', new Date('2026-11-01')), approved('INSURANCE', new Date('2027-06-01'))];
    expect(partnerVerification('MOTORCYCLE', expired, NOW).missing).toEqual(['DRIVERS_LICENSE']);
    const pending = [...base, { type: 'DRIVERS_LICENSE', status: 'PENDING', expiresAt: null }, approved('INSURANCE')];
    expect(partnerVerification('MOTORCYCLE', pending, NOW).missing).toEqual(['DRIVERS_LICENSE']);
  });
});

describe('LogisticsService: documents gate', () => {
  function setup(required: boolean, docs: unknown[]) {
    const prisma: any = {
      deliveryPartnerProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', staffUserId: 's1', type: 'WALKING' }),
        update: jest.fn().mockResolvedValue({ id: 'p1', isAvailable: true }),
      },
      partnerDocument: { findMany: jest.fn().mockResolvedValue(docs) },
      delivery: { findUnique: jest.fn().mockResolvedValue({ id: 'd1', partnerId: null, claimedByStaffId: null, status: 'ASSIGNED', order: { type: 'FOOD' } }) },
      $transaction: jest.fn().mockResolvedValue({ id: 'd1' }),
    };
    const settings = { get: jest.fn().mockResolvedValue(required) };
    const svc = new LogisticsService(prisma, new EventEmitter2(), settings as any);
    return { svc, prisma };
  }

  it('off (the default): nothing changes, documents are not even looked up', async () => {
    const { svc, prisma } = setup(false, []);
    await svc.updatePartnerStatus('s1', { isAvailable: true } as any);
    expect(prisma.partnerDocument.findMany).not.toHaveBeenCalled();
    expect(prisma.deliveryPartnerProfile.update).toHaveBeenCalled();
  });

  it('on: going online without approved documents is a 403 listing what is missing', async () => {
    const { svc, prisma } = setup(true, [approved('ID_CARD')]);
    await expect(svc.updatePartnerStatus('s1', { isAvailable: true } as any)).rejects.toMatchObject({
      response: { code: 'DOCUMENTS_REQUIRED', missing: ['PROFILE_PHOTO'] },
    });
    expect(prisma.deliveryPartnerProfile.update).not.toHaveBeenCalled();
  });

  it('on: going offline is always allowed', async () => {
    const { svc, prisma } = setup(true, []);
    await svc.updatePartnerStatus('s1', { isAvailable: false } as any);
    expect(prisma.deliveryPartnerProfile.update).toHaveBeenCalled();
  });

  it('on: claiming a delivery is refused until verified, then allowed', async () => {
    const blocked = setup(true, []);
    await expect(blocked.svc.claim('d1', 's1', 'DELIVERY_PARTNER')).rejects.toBeInstanceOf(ForbiddenException);
    expect(blocked.prisma.$transaction).not.toHaveBeenCalled();

    const ok = setup(true, [approved('ID_CARD'), approved('PROFILE_PHOTO')]);
    await ok.svc.claim('d1', 's1', 'DELIVERY_PARTNER').catch(() => undefined);
    expect(ok.prisma.$transaction).toHaveBeenCalled();
  });
});
