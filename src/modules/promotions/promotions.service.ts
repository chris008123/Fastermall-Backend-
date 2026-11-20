import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Promotion, PromotionCtaType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../shared/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { sniffImageType, UploadedImage } from '../marketplace/product-images.service';
import { toMainWebp } from '../../shared/images/image-processing';
import {
  CreatePromotionDto,
  PromotionEventType,
  PromotionStatus,
  PromotionThemeDto,
  UpdatePromotionDto,
} from './dto/promotion.dto';
import { legacyAnimation } from './animations';
import { checkLottie } from './lottie';

// Live promotions the app gets at most (the popup shows the first; the rest
// can be a carousel).
const ACTIVE_LIMIT = 10;
// Re-announcing the same promotion is refused for this long (no push spam).
const ANNOUNCE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
// Largest Lottie file accepted (PROMOTION_LOTTIE_MAX_BYTES).
const DEFAULT_LOTTIE_MAX_BYTES = 512 * 1024;

const EVENT_COUNTER: Record<PromotionEventType, 'viewCount' | 'clickCount' | 'dismissCount'> = {
  VIEW: 'viewCount',
  CLICK: 'clickCount',
  DISMISS: 'dismissCount',
};

/**
 * The theme as stored: what the admin sent, with `animation` filled in for
 * apps released before Nov 2026 (they read nothing else).
 */
export function normalizeTheme(theme: PromotionThemeDto | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!theme) return Prisma.JsonNull;
  // Plain object (the DTO is a class instance) without undefined keys.
  const plain = JSON.parse(JSON.stringify(theme));
  const animation = legacyAnimation(plain);
  if (animation) plain.animation = animation;
  return plain;
}

/** Admin rows: counters plus the click rate (clicks per view, 0-1, null with no views). */
function withStats<T extends { viewCount?: number; clickCount?: number }>(p: T) {
  const views = p.viewCount ?? 0;
  return { ...p, clickRate: views > 0 ? Math.round(((p.clickCount ?? 0) / views) * 1000) / 1000 : null };
}

const PUBLIC_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  body: true,
  imageUrl: true,
  ctaLabel: true,
  ctaType: true,
  ctaValue: true,
  theme: true,
  lottieUrl: true,
  lottieInfo: true,
  startsAt: true,
  endsAt: true,
  priority: true,
  frequency: true,
  updatedAt: true,
} satisfies Prisma.PromotionSelect;

/** Prisma filter for "live at `now`". */
export function liveAt(now: Date): Prisma.PromotionWhereInput {
  return {
    isActive: true,
    startsAt: { lte: now },
    OR: [{ endsAt: null }, { endsAt: { gt: now } }],
  };
}

/** Where a promotion is in its life, for the admin console. */
export function promotionStatus(p: Pick<Promotion, 'isActive' | 'startsAt' | 'endsAt'>, now: Date): PromotionStatus {
  if (!p.isActive) return 'inactive';
  if (p.endsAt && p.endsAt <= now) return 'ended';
  if (p.startsAt > now) return 'scheduled';
  return 'live';
}

/**
 * Promotions (requirement 2.1): admins create them; the customer app shows
 * the live ones as a popup when it opens.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** The current time. A method so tests can pin it. */
  protected now() {
    return new Date();
  }

  private get bucket() {
    return this.config.get<string>('promotionImages.bucket') ?? 'promotion-images';
  }
  private get maxBytes() {
    return this.config.get<number>('productImages.maxBytes') ?? 5 * 1024 * 1024;
  }
  private get lottieMaxBytes() {
    return this.config.get<number>('promotionImages.lottieMaxBytes') ?? DEFAULT_LOTTIE_MAX_BYTES;
  }

  // ───────── App ─────────

  /** Live promotions, highest priority first, newest first among equals. */
  listActive() {
    return this.prisma.promotion.findMany({
      where: liveAt(this.now()),
      orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'asc' }],
      take: ACTIVE_LIMIT,
      select: PUBLIC_SELECT,
    });
  }

  /**
   * Counts a view, button tap or dismissal sent by the app. Only live
   * promotions count (an admin preview or a stale popup is ignored), and an
   * unknown id is ignored too, so the app never has to handle an error here.
   */
  async recordEvent(id: string, type: PromotionEventType) {
    const counter = EVENT_COUNTER[type];
    const result = await this.prisma.promotion.updateMany({
      where: { id, ...liveAt(this.now()) },
      data: { [counter]: { increment: 1 } },
    });
    return { recorded: result.count === 1 };
  }

  // ───────── Admin ─────────

  async listAll(status?: PromotionStatus) {
    const now = this.now();
    const where: Prisma.PromotionWhereInput =
      status === 'live'
        ? liveAt(now)
        : status === 'scheduled'
          ? { isActive: true, startsAt: { gt: now } }
          : status === 'ended'
            ? { isActive: true, endsAt: { lte: now } }
            : status === 'inactive'
              ? { isActive: false }
              : {};
    const rows = await this.prisma.promotion.findMany({
      where,
      orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
      take: 200,
    });
    return rows.map((p) => withStats({ ...p, status: promotionStatus(p, now) }));
  }

  async findOne(id: string) {
    const p = await this.prisma.promotion.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    return withStats({ ...p, status: promotionStatus(p, this.now()) });
  }

  /**
   * Exactly what the app will get for this promotion, whatever its status,
   * so the console can show the popup before it goes live.
   */
  async preview(id: string) {
    const p = await this.prisma.promotion.findUnique({ where: { id }, select: { ...PUBLIC_SELECT, isActive: true } });
    if (!p) throw new NotFoundException('Promotion not found');
    const { isActive, ...promotion } = p;
    return { status: promotionStatus({ isActive, startsAt: p.startsAt, endsAt: p.endsAt }, this.now()), promotion };
  }

  async create(dto: CreatePromotionDto, adminId: string) {
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : this.now();
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    this.assertDates(startsAt, endsAt);
    const cta = await this.checkCta(dto.ctaType ?? PromotionCtaType.NONE, dto.ctaValue, dto.ctaLabel);
    this.assertImageUrl(dto.imageUrl);

    const created = await this.prisma.promotion.create({
      data: {
        title: dto.title,
        subtitle: dto.subtitle || null,
        body: dto.body || null,
        imageUrl: dto.imageUrl || null,
        ...cta,
        theme: normalizeTheme(dto.theme),
        startsAt,
        endsAt,
        isActive: dto.isActive ?? true,
        priority: dto.priority ?? 0,
        frequency: dto.frequency ?? 'ONCE',
        createdById: adminId,
      },
    });
    return withStats({ ...created, status: promotionStatus(created, this.now()) });
  }

  async update(id: string, dto: UpdatePromotionDto) {
    const current = await this.prisma.promotion.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Promotion not found');

    const data: Prisma.PromotionUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.subtitle !== undefined) data.subtitle = dto.subtitle || null;
    if (dto.body !== undefined) data.body = dto.body || null;
    if (dto.imageUrl !== undefined) {
      this.assertImageUrl(dto.imageUrl);
      data.imageUrl = dto.imageUrl || null;
      data.imagePath = null; // a hand-set URL replaces an uploaded image
    }
    if (dto.theme !== undefined) data.theme = normalizeTheme(dto.theme);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.frequency !== undefined) data.frequency = dto.frequency;

    const startsAt = dto.startsAt !== undefined ? new Date(dto.startsAt) : current.startsAt;
    const endsAt = dto.endsAt !== undefined ? (dto.endsAt ? new Date(dto.endsAt) : null) : current.endsAt;
    if (dto.startsAt !== undefined || dto.endsAt !== undefined) {
      this.assertDates(startsAt, endsAt);
      data.startsAt = startsAt;
      data.endsAt = endsAt;
    }

    if (dto.ctaType !== undefined || dto.ctaValue !== undefined || dto.ctaLabel !== undefined) {
      Object.assign(
        data,
        await this.checkCta(
          dto.ctaType ?? current.ctaType,
          dto.ctaValue !== undefined ? dto.ctaValue : current.ctaValue ?? undefined,
          dto.ctaLabel !== undefined ? dto.ctaLabel : current.ctaLabel ?? undefined,
        ),
      );
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to update');

    const updated = await this.prisma.promotion.update({ where: { id }, data });
    if (data.imagePath === null && current.imagePath) {
      await this.storage.removeFromBucket(this.bucket, [current.imagePath]);
    }
    return withStats({ ...updated, status: promotionStatus(updated, this.now()) });
  }

  async remove(id: string) {
    const current = await this.prisma.promotion.findUnique({ where: { id }, select: { imagePath: true, lottiePath: true } });
    if (!current) throw new NotFoundException('Promotion not found');
    await this.prisma.promotion.delete({ where: { id } });
    const files = [current.imagePath, current.lottiePath].filter((f): f is string => !!f);
    if (files.length) await this.storage.removeFromBucket(this.bucket, files);
    return { deleted: true };
  }

  /**
   * Uploads (or replaces) the promotion's Lottie animation. The file is
   * checked (see lottie.ts) and stored minified in the promotion-images bucket.
   */
  async setLottie(id: string, file: UploadedImage | undefined) {
    const current = await this.prisma.promotion.findUnique({ where: { id }, select: { lottiePath: true } });
    if (!current) throw new NotFoundException('Promotion not found');
    if (!file) {
      throw new BadRequestException({ message: 'Attach the Lottie JSON file in the "animation" field', code: 'NO_ANIMATION_FILE' });
    }
    if (file.size > this.lottieMaxBytes || file.buffer.length > this.lottieMaxBytes) {
      throw new PayloadTooLargeException({
        message: `The animation file must be at most ${Math.round(this.lottieMaxBytes / 1024)} KB`,
        code: 'LOTTIE_FILE_TOO_LARGE',
      });
    }
    const { json, info } = checkLottie(file.buffer);

    const path = `promotions/${id}/${randomUUID()}.json`;
    const { publicUrl } = await this.storage.uploadPublic(this.bucket, path, json, 'application/json');
    try {
      const updated = await this.prisma.promotion.update({
        where: { id },
        data: { lottieUrl: publicUrl, lottiePath: path, lottieInfo: info as unknown as Prisma.InputJsonValue },
      });
      if (current.lottiePath) await this.storage.removeFromBucket(this.bucket, [current.lottiePath]);
      return withStats({ ...updated, status: promotionStatus(updated, this.now()) });
    } catch (error) {
      await this.storage.removeFromBucket(this.bucket, [path]);
      throw error;
    }
  }

  /** Removes the Lottie animation; the popup goes back to the theme presets. */
  async removeLottie(id: string) {
    const current = await this.prisma.promotion.findUnique({ where: { id }, select: { lottiePath: true } });
    if (!current) throw new NotFoundException('Promotion not found');
    const updated = await this.prisma.promotion.update({
      where: { id },
      data: { lottieUrl: null, lottiePath: null, lottieInfo: Prisma.JsonNull },
    });
    if (current.lottiePath) await this.storage.removeFromBucket(this.bucket, [current.lottiePath]);
    return withStats({ ...updated, status: promotionStatus(updated, this.now()) });
  }

  /** Uploads (or replaces) the popup image. JPEG, PNG or WebP in; stored as WebP, max 1600 px. */
  async setImage(id: string, file: UploadedImage | undefined) {
    const current = await this.prisma.promotion.findUnique({ where: { id }, select: { imagePath: true } });
    if (!current) throw new NotFoundException('Promotion not found');
    if (!file) throw new BadRequestException({ message: 'Attach the image in the "image" field', code: 'NO_IMAGE' });
    if (file.size > this.maxBytes || file.buffer.length > this.maxBytes) {
      throw new PayloadTooLargeException({ message: 'The image is too large', code: 'IMAGE_TOO_LARGE' });
    }
    const type = sniffImageType(file.buffer);
    if (!type) {
      throw new BadRequestException({ message: 'The image must be JPEG, PNG or WebP', code: 'UNSUPPORTED_IMAGE_TYPE' });
    }

    const image = await toMainWebp(file.buffer);
    const path = `promotions/${id}/${randomUUID()}.webp`;
    const { publicUrl } = await this.storage.uploadPublic(this.bucket, path, image.buffer, image.contentType);
    try {
      const updated = await this.prisma.promotion.update({ where: { id }, data: { imageUrl: publicUrl, imagePath: path } });
      if (current.imagePath) await this.storage.removeFromBucket(this.bucket, [current.imagePath]);
      return withStats({ ...updated, status: promotionStatus(updated, this.now()) });
    } catch (error) {
      await this.storage.removeFromBucket(this.bucket, [path]);
      throw error;
    }
  }

  /**
   * Pushes a live promotion to every customer (and adds it to their in-app
   * list). Respects each phone's "announcements" switch. Refused for a
   * promotion that is not live, or that was announced in the last 12 hours.
   */
  async announce(id: string) {
    const p = await this.prisma.promotion.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    const now = this.now();
    if (promotionStatus(p, now) !== 'live') {
      throw new ConflictException({ message: 'Only a live promotion can be announced', code: 'PROMOTION_NOT_LIVE' });
    }
    if (p.announcedAt && now.getTime() - p.announcedAt.getTime() < ANNOUNCE_COOLDOWN_MS) {
      throw new ConflictException({ message: 'This promotion was announced recently', code: 'ALREADY_ANNOUNCED' });
    }
    if (!this.notifications) throw new ConflictException('Notifications are not available');

    // Claim the announcement first so two clicks can't both push.
    const claimed = await this.prisma.promotion.updateMany({
      where: { id, announcedAt: p.announcedAt },
      data: { announcedAt: now },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({ message: 'This promotion was announced recently', code: 'ALREADY_ANNOUNCED' });
    }

    let result: { recipients: number };
    try {
      result = await this.notifications.broadcast('CUSTOMERS', p.title, p.subtitle || p.body || p.title, {
        type: 'PROMOTION',
        data: { promotionId: p.id },
      });
    } catch (error) {
      // Nothing (or not everything) went out: let the admin try again.
      await this.prisma.promotion.updateMany({ where: { id, announcedAt: now }, data: { announcedAt: p.announcedAt } });
      throw error;
    }
    return { promotionId: p.id, announcedAt: now, recipients: result.recipients };
  }

  // ───────── Checks ─────────

  private assertDates(startsAt: Date, endsAt: Date | null) {
    if (endsAt && endsAt <= startsAt) {
      throw new BadRequestException({ message: 'The end must be after the start', code: 'INVALID_DATES' });
    }
  }

  private assertImageUrl(url?: string | null) {
    if (url && !/^https:\/\/\S+$/i.test(url)) {
      throw new BadRequestException({ message: 'imageUrl must be an https link', code: 'INVALID_IMAGE_URL' });
    }
  }

  // The button must point at something that exists.
  private async checkCta(type: PromotionCtaType, value?: string | null, label?: string | null) {
    const v = value?.trim() || null;
    if (type === PromotionCtaType.NONE) {
      return { ctaType: type, ctaValue: null, ctaLabel: label?.trim() || null };
    }
    if (!v) {
      throw new BadRequestException({ message: `ctaValue is required for ${type}`, code: 'INVALID_CTA' });
    }
    const exists =
      type === PromotionCtaType.URL
        ? /^https:\/\/\S+$/i.test(v)
        : type === PromotionCtaType.PRODUCT
          ? !!(await this.prisma.product.findUnique({ where: { id: v }, select: { id: true } }))
          : type === PromotionCtaType.CATEGORY
            ? !!(await this.prisma.category.findUnique({ where: { id: v }, select: { id: true } }))
            : type === PromotionCtaType.VENDOR
              ? !!(await this.prisma.marketplaceVendor.findUnique({ where: { id: v }, select: { id: true } }))
              : !!(await this.prisma.foodVendor.findUnique({ where: { id: v }, select: { id: true } }));
    if (!exists) {
      throw new BadRequestException({
        message: type === PromotionCtaType.URL ? 'ctaValue must be an https link' : `No ${type.toLowerCase().replace('_', ' ')} with that id`,
        code: 'INVALID_CTA',
      });
    }
    return { ctaType: type, ctaValue: v, ctaLabel: label?.trim() || null };
  }
}
