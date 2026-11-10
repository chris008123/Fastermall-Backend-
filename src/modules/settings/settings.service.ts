import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Platform settings an admin can change without a redeploy. Each value has a
 * default (from env / the previous hard-coded value), used whenever no row is
 * stored or the settings table can't be read, so a settings problem never
 * breaks ordering.
 */
export interface PlatformSettings {
  /** Flat delivery fee on marketplace orders (GHS). */
  marketplaceDeliveryFee: number;
  /** Fee when a laundry order is collected from the customer (GHS). */
  laundryPickupFee: number;
  /** What a delivery partner earns per completed delivery (GHS). */
  partnerEarningPerDelivery: number;
  /** When on, customers can't place new orders or laundry orders. */
  maintenanceMode: boolean;
  /** Shown to customers while maintenance mode is on. */
  maintenanceMessage: string;
  /**
   * The manager's WhatsApp number for "Contact us", in international form
   * without + (e.g. 233241234567). Empty until an admin sets it.
   */
  whatsappContactNumber: string;
}

export type SettingKey = keyof PlatformSettings;

/**
 * Turns what an admin types into the form wa.me needs: digits only, country
 * code first, no +. "+233 24 123 4567", "0241234567" (Ghana local) and
 * "233241234567" all become "233241234567". Other values pass through and
 * are then checked by the rule below.
 */
export function normalizeWhatsAppNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const digits = value.trim().replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  return digits;
}

/** https://wa.me/<number>, or null when no number is set. */
export function whatsappUrl(number: string | null | undefined): string | null {
  return number ? `https://wa.me/${number}` : null;
}

const MONEY_MAX = 10_000;
const CACHE_MS = 30_000;

type Rule = (v: unknown) => string | null;
const money: Rule = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MONEY_MAX && Math.round(v * 100) === v * 100
    ? null
    : `must be an amount between 0 and ${MONEY_MAX} with at most 2 decimals`;
const RULES: Record<SettingKey, Rule> = {
  marketplaceDeliveryFee: money,
  laundryPickupFee: money,
  partnerEarningPerDelivery: money,
  maintenanceMode: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  maintenanceMessage: (v) => (typeof v === 'string' && v.length <= 300 ? null : 'must be text of at most 300 characters'),
  // Empty clears it. Otherwise 10 to 15 digits with the country code.
  whatsappContactNumber: (v) =>
    typeof v === 'string' && (v === '' || /^[1-9]\d{9,14}$/.test(v))
      ? null
      : 'must be a phone number with its country code, e.g. 233241234567 (or empty to remove it)',
};

// Applied to incoming values before the rules run.
const NORMALIZE: Partial<Record<SettingKey, (v: unknown) => unknown>> = {
  whatsappContactNumber: normalizeWhatsAppNumber,
};
export const SETTING_KEYS = Object.keys(RULES) as SettingKey[];

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { at: number; value: PlatformSettings } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  defaults(): PlatformSettings {
    return {
      marketplaceDeliveryFee: Number(this.config.get<number>('orders.marketplaceDeliveryFee') ?? 5),
      laundryPickupFee: 5,
      partnerEarningPerDelivery: 15,
      maintenanceMode: false,
      maintenanceMessage: 'Fastermall is down for maintenance. Please try again shortly.',
      whatsappContactNumber: '',
    };
  }

  async getAll(): Promise<PlatformSettings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const value = this.defaults();
    try {
      const rows = await this.prisma.platformSetting.findMany();
      for (const row of rows) {
        const key = row.key as SettingKey;
        if (key in RULES && RULES[key](row.value) === null) (value as any)[key] = row.value;
      }
    } catch (e) {
      this.logger.error(`Settings read failed, using defaults: ${(e as Error).message}`);
      return value; // not cached, so it's retried next time
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  async get<K extends SettingKey>(key: K): Promise<PlatformSettings[K]> {
    return (await this.getAll())[key];
  }

  /** Validates every given key first; nothing is saved if any is invalid. */
  async update(changes: Record<string, unknown>, staffId: string): Promise<PlatformSettings> {
    const entries = Object.entries(changes ?? {}).map(
      ([key, v]) => [key, NORMALIZE[key as SettingKey]?.(v) ?? v] as [string, unknown],
    );
    if (entries.length === 0) throw new BadRequestException('Nothing to update');
    const errors: string[] = [];
    for (const [key, v] of entries) {
      if (!(key in RULES)) errors.push(`Unknown setting "${key}"`);
      else {
        const err = RULES[key as SettingKey](v);
        if (err) errors.push(`${key} ${err}`);
      }
    }
    if (errors.length) throw new BadRequestException(errors);

    await this.prisma.$transaction(
      entries.map(([key, v]) =>
        this.prisma.platformSetting.upsert({
          where: { key },
          create: { key, value: v as Prisma.InputJsonValue, updatedById: staffId },
          update: { value: v as Prisma.InputJsonValue, updatedById: staffId },
        }),
      ),
    );
    this.cache = null;
    return this.getAll();
  }

  /** Throws the maintenance message when customers can't order right now. */
  async assertOrderingOpen() {
    const s = await this.getAll();
    if (s.maintenanceMode) throw new ServiceUnavailableException(s.maintenanceMessage);
  }
}
