import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService, whatsappUrl } from '../settings/settings.service';

export type AppName = 'partner' | 'customer';

/** "1.10.2" vs "1.9": -1, 0 or 1. Missing parts count as 0; junk counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Settings the apps read on start-up instead of having them baked in:
 * the oldest app version still allowed, a maintenance notice, support contacts
 * and legal links. Most values come from environment settings (change the
 * setting on the host and restart). Maintenance also follows the admin
 * switch in platform settings (PATCH /admin/settings), the same one that
 * stops new orders, so the two never disagree.
 */
@Injectable()
export class AppConfigService {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async get(app: AppName, version?: string) {
    const env = (k: string) => this.config.get<string>(k) || undefined;
    const platform = this.settings ? await this.settings.getAll() : null;
    const adminMaintenance = !!platform?.maintenanceMode;
    const minVersion = env(app === 'partner' ? 'APP_MIN_VERSION_PARTNER' : 'APP_MIN_VERSION_CUSTOMER') ?? null;

    return {
      app,
      minVersion,
      // Only when the app says which version it is.
      updateRequired: minVersion && version ? compareVersions(version, minVersion) < 0 : false,
      updateUrl: env(app === 'partner' ? 'APP_UPDATE_URL_PARTNER' : 'APP_UPDATE_URL_CUSTOMER') ?? null,
      maintenance: {
        enabled: adminMaintenance || this.config.get<string>('MAINTENANCE_MODE') === 'true',
        message: adminMaintenance
          ? platform!.maintenanceMessage
          : env('MAINTENANCE_MESSAGE') ?? 'We are doing some maintenance. Please try again shortly.',
      },
      support: {
        phone: env('SUPPORT_PHONE') ?? null,
        email: env('SUPPORT_EMAIL') ?? null,
        // The manager's WhatsApp (admin setting), for "Contact us".
        whatsapp: platform?.whatsappContactNumber || null,
        whatsappUrl: whatsappUrl(platform?.whatsappContactNumber),
      },
      legal: {
        privacyUrl: env('PRIVACY_URL') ?? null,
        termsUrl: env('TERMS_URL') ?? null,
      },
      serverTime: new Date().toISOString(),
    };
  }
}
