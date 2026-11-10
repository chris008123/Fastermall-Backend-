import { NotFoundException } from '@nestjs/common';
import { ACTIVE_SECTIONS, PreferencesService, resolvePreferences } from './preferences.service';

describe('PreferencesService', () => {
  let svc: PreferencesService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      deliveryPartnerProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', preferences: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    svc = new PreferencesService(prisma);
  });

  it('fills in defaults for a partner who saved nothing, and says what is live', async () => {
    const prefs: any = await svc.get('s1');
    expect(prefs.notifications).toMatchObject({ newJobs: true, promotions: false, sound: true });
    expect(prefs.delivery).toMatchObject({ autoAccept: false, pickupRadiusKm: null });
    expect(prefs.active).toEqual(ACTIVE_SECTIONS);
    expect(prefs.active.delivery).toBe(false);
    expect(prefs.active.notifications.newJobs).toBe(true);
  });

  it('changes only what was sent and keeps the rest', async () => {
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'p1', preferences: { notifications: { sound: false }, navigation: { avoidTolls: true } } });
    const out: any = await svc.update('s1', { notifications: { newJobs: false }, delivery: { pickupRadiusKm: 5 } });
    expect(out.notifications).toMatchObject({ newJobs: false, sound: false, payments: true });
    expect(out.navigation.avoidTolls).toBe(true);
    expect(out.delivery.pickupRadiusKm).toBe(5);
    const saved = prisma.deliveryPartnerProfile.update.mock.calls[0][0].data.preferences;
    expect(saved.notifications).toMatchObject({ newJobs: false, sound: false });
    expect(saved).not.toHaveProperty('active');
  });

  it('ignores keys sent as undefined', async () => {
    const out: any = await svc.update('s1', { notifications: { newJobs: undefined, sound: false } });
    expect(out.notifications).toMatchObject({ newJobs: true, sound: false });
  });

  it('404s for an account with no partner profile', async () => {
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(null);
    await expect(svc.get('x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolvePreferences copes with junk', () => {
    expect(resolvePreferences('nonsense' as any).notifications.newJobs).toBe(true);
    expect(resolvePreferences(null).delivery.autoAccept).toBe(false);
  });
});
