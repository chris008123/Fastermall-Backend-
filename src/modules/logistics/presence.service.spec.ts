import { ConflictException, NotFoundException } from '@nestjs/common';
import { CLEARED_LOCATION, PresenceService } from './presence.service';

describe('PresenceService', () => {
  let svc: PresenceService;
  let prisma: any;
  let settings: Record<string, unknown>;
  const config: any = { get: (k: string) => settings[k] };

  beforeEach(() => {
    settings = { 'presence.autoOffline': false, 'presence.offlineAfterSeconds': 180, 'presence.updateEverySeconds': 60 };
    prisma = {
      deliveryPartnerProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', isAvailable: true }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    svc = new PresenceService(prisma, config);
  });

  describe('updateLocation', () => {
    it('stores only the latest position, with the server clock', async () => {
      const out: any = await svc.updateLocation('s1', { latitude: 5.6037, longitude: -0.187, accuracyMeters: 12 });
      const data = prisma.deliveryPartnerProfile.update.mock.calls[0][0].data;
      expect(data).toMatchObject({ currentLat: 5.6037, currentLng: -0.187, locationAccuracyM: 12 });
      expect(data.locationAt).toBeInstanceOf(Date);
      expect(data.lastSeenAt).toBeInstanceOf(Date);
      expect(out.nextUpdateInSeconds).toBe(60);
    });

    it('refuses with 409 PARTNER_OFFLINE when the partner is not online', async () => {
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'p1', isAvailable: false });
      const err: any = await svc.updateLocation('s1', { latitude: 1, longitude: 1 }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('PARTNER_OFFLINE');
      expect(prisma.deliveryPartnerProfile.update).not.toHaveBeenCalled();
    });

    it('404s for an account with no partner profile', async () => {
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(null);
      await expect(svc.updateLocation('x', { latitude: 1, longitude: 1 })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('heartbeat records being seen, even offline', async () => {
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'p1', isAvailable: false });
    await expect(svc.heartbeat('s1')).resolves.toMatchObject({ isAvailable: false, nextUpdateInSeconds: 60 });
    expect(prisma.deliveryPartnerProfile.update.mock.calls[0][0].data.lastSeenAt).toBeInstanceOf(Date);
  });

  describe('touch', () => {
    it('writes at most every 30 seconds', async () => {
      await svc.touch('s1');
      const where = prisma.deliveryPartnerProfile.updateMany.mock.calls[0][0].where;
      expect(where.staffUserId).toBe('s1');
      expect(where.OR[0]).toEqual({ lastSeenAt: null });
      expect(where.OR[1].lastSeenAt.lt).toBeInstanceOf(Date);
    });

    it('never throws, even if the database does', async () => {
      prisma.deliveryPartnerProfile.updateMany.mockRejectedValue(new Error('db down'));
      await expect(svc.touch('s1')).resolves.toBeUndefined();
    });
  });

  describe('sweep (auto-offline)', () => {
    it('does nothing unless switched on', async () => {
      await expect(svc.sweep()).resolves.toEqual({ offlined: 0 });
      expect(prisma.deliveryPartnerProfile.updateMany).not.toHaveBeenCalled();
    });

    it('takes quiet partners offline and clears their position', async () => {
      settings['presence.autoOffline'] = true;
      prisma.deliveryPartnerProfile.updateMany.mockResolvedValue({ count: 2 });
      await expect(svc.sweep()).resolves.toEqual({ offlined: 2 });
      const arg = prisma.deliveryPartnerProfile.updateMany.mock.calls[0][0];
      expect(arg.where.isAvailable).toBe(true);
      expect(arg.where.OR[0]).toEqual({ lastSeenAt: null });
      expect(arg.where.OR[1].lastSeenAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 180 * 1000 + 50);
      expect(arg.data).toEqual({ isAvailable: false, ...CLEARED_LOCATION });
    });
  });
});
