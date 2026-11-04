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
}

export type SettingKey = keyof PlatformSettings;

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
    const entries = Object.entries(changes ?? {});
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
