import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PartnerPreferencesDto } from './dto/partner-preferences.dto';

export const DEFAULT_PREFERENCES = {
  notifications: { newJobs: true, jobUpdates: true, payments: true, promotions: false, sound: true, vibration: true },
  delivery: { autoAccept: false, pickupRadiusKm: null as number | null, maxDistanceKm: null as number | null, jobTypes: null as string[] | null },
  navigation: { preferredMapApp: null as string | null, avoidTolls: false, avoidHighways: false },
};

/** Saved values over the defaults, section by section. */
export function resolvePreferences(saved: unknown) {
  const s = (saved ?? {}) as Record<string, Record<string, unknown>>;
  return {
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...(s.notifications ?? {}) },
    delivery: { ...DEFAULT_PREFERENCES.delivery, ...(s.delivery ?? {}) },
    navigation: { ...DEFAULT_PREFERENCES.navigation, ...(s.navigation ?? {}) },
  };
}

/**
 * A partner's saved settings. They follow the account, so they carry over to a
 * new phone.
 *
 * Be honest with the app about what is live: `active` says which sections the
 * backend actually acts on today.
 *  - notifications.newJobs and notifications.sound: acted on (push for new jobs).
 *  - notifications.vibration: the phone's own notification channel decides.
 *  - delivery.*: saved only. Radius and distance matching need the partner's
 *    location, which is not collected yet.
 *  - navigation.*: only the app uses these.
 */
export const ACTIVE_SECTIONS = {
  notifications: { newJobs: true, jobUpdates: false, payments: false, promotions: false, sound: true, vibration: false },
  delivery: false,
  navigation: false,
};

@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  private async profileFor(userId: string) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({
      where: { staffUserId: userId },
      select: { id: true, preferences: true },
    });
    if (!profile) throw new NotFoundException('You are not registered as a delivery partner');
    return profile;
  }

  async get(userId: string) {
    const profile = await this.profileFor(userId);
    return { ...resolvePreferences(profile.preferences), active: ACTIVE_SECTIONS };
  }

  async update(userId: string, dto: PartnerPreferencesDto) {
    const profile = await this.profileFor(userId);
    const current = resolvePreferences(profile.preferences);

    const strip = <T extends object>(o?: T) =>
      Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));

    const next = {
      notifications: { ...current.notifications, ...strip(dto.notifications) },
      delivery: { ...current.delivery, ...strip(dto.delivery) },
      navigation: { ...current.navigation, ...strip(dto.navigation) },
    };

    await this.prisma.deliveryPartnerProfile.update({
      where: { id: profile.id },
      data: { preferences: next },
    });

    return { ...next, active: ACTIVE_SECTIONS };
  }
}
