import { BadRequestException, ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import { liveAt, promotionStatus, PromotionsService } from './promotions.service';
import { AdminPromotionsController, PromotionsController } from './promotions.controller';
import { CreatePromotionDto } from './dto/promotion.dto';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';

const NOW = new Date('2026-11-10T12:00:00Z');
import sharp = require('sharp');

// A real 2400 x 1200 JPEG, made once: uploads are now converted.
let JPEG: Buffer;
beforeAll(async () => {
  JPEG = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#e07b2a' } }).jpeg().toBuffer();
});

function setup(row: any = null) {
  const prisma: any = {
    promotion: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(row),
      create: jest.fn(({ data }) => Promise.resolve({ id: 'pr1', ...data })),
      update: jest.fn(({ data }) => Promise.resolve({ ...row, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    product: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }) },
    category: { findUnique: jest.fn().mockResolvedValue({ id: 'c1' }) },
    marketplaceVendor: { findUnique: jest.fn().mockResolvedValue(null) },
    foodVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'f1' }) },
  };
  const storage = {
    uploadPublic: jest.fn((bucket: string, path: string, _b?: Buffer, _t?: string) => Promise.resolve({ path, publicUrl: `https://x/${bucket}/${path}` })),
    removeFromBucket: jest.fn().mockResolvedValue(undefined),
  };
  const notifications = { broadcast: jest.fn().mockResolvedValue({ audience: 'CUSTOMERS', recipients: 42 }) };
  const svc = new PromotionsService(prisma, storage as any, { get: () => undefined } as any, notifications as any);
  (svc as any).now = () => NOW;
  return { svc, prisma, storage, notifications };
}

const promo = (over: any = {}) => ({
  id: 'pr1',
  title: 'Black Friday',
  subtitle: '20% off snacks',
  body: null,
  imageUrl: null,
  imagePath: null,
  ctaType: 'NONE',
  ctaValue: null,
  ctaLabel: null,
  isActive: true,
  startsAt: new Date('2026-11-01T00:00:00Z'),
  endsAt: new Date('2026-11-30T00:00:00Z'),
  announcedAt: null,
  ...over,
});

describe('which promotions are live', () => {
  it('live = active, started, and not yet ended (no end date = open-ended)', () => {
    expect(liveAt(NOW)).toEqual({ isActive: true, startsAt: { lte: NOW }, OR: [{ endsAt: null }, { endsAt: { gt: NOW } }] });
  });

  it.each([
    [{}, 'live'],
    [{ endsAt: null }, 'live'],
    [{ startsAt: new Date('2026-11-11T00:00:00Z') }, 'scheduled'],
    [{ endsAt: new Date('2026-11-10T12:00:00Z') }, 'ended'],
    [{ isActive: false }, 'inactive'],
  ])('%p is %s', (over, status) => {
    expect(promotionStatus(promo(over) as any, NOW)).toBe(status);
  });

  it('GET /promotions/active: live ones only, highest priority first, at most 10, no admin fields', async () => {
    const { svc, prisma } = setup();
    await svc.listActive();
    const arg = prisma.promotion.findMany.mock.calls[0][0];
    expect(arg.where).toEqual(liveAt(NOW));
    expect(arg.orderBy[0]).toEqual({ priority: 'desc' });
    expect(arg.take).toBe(10);
    expect(arg.select).not.toHaveProperty('createdById');
    expect(arg.select).not.toHaveProperty('imagePath');
    expect(arg.select).toMatchObject({ theme: true, frequency: true, ctaType: true });
  });
});

describe('creating and editing', () => {
  it('starts now by default, open-ended, ONCE, and records who created it', async () => {
    const { svc, prisma } = setup();
    const out: any = await svc.create({ title: 'Sale' } as any, 'admin1');
    expect(prisma.promotion.create.mock.calls[0][0].data).toMatchObject({
      title: 'Sale', startsAt: NOW, endsAt: null, isActive: true, priority: 0, frequency: 'ONCE', ctaType: 'NONE', createdById: 'admin1',
    });
    expect(out.status).toBe('live');
  });

  it('checks the button target exists (product, category, vendor, food vendor) or is an https link', async () => {
    const { svc } = setup();
    await expect(svc.create({ title: 'A', ctaType: 'PRODUCT', ctaValue: 'p1' } as any, 'a')).resolves.toMatchObject({ ctaValue: 'p1' });
    await expect(svc.create({ title: 'A', ctaType: 'FOOD_VENDOR', ctaValue: 'f1' } as any, 'a')).resolves.toBeDefined();
    await expect(svc.create({ title: 'A', ctaType: 'URL', ctaValue: 'https://fastermall.com/deals' } as any, 'a')).resolves.toBeDefined();
    for (const bad of [
      { ctaType: 'VENDOR', ctaValue: 'missing' },
      { ctaType: 'PRODUCT' },
      { ctaType: 'URL', ctaValue: 'http://insecure.example.com' },
      { ctaType: 'URL', ctaValue: 'javascript:alert(1)' },
    ]) {
      const err: any = await svc.create({ title: 'A', ...bad } as any, 'a').catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe('INVALID_CTA');
    }
  });

  it('refuses an end before the start, and a non-https image link', async () => {
    const { svc } = setup();
    await expect(svc.create({ title: 'A', startsAt: '2026-11-20T00:00:00Z', endsAt: '2026-11-19T00:00:00Z' } as any, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ title: 'A', imageUrl: 'http://x/y.png' } as any, 'a')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('edits only what is sent; checks new dates against the stored ones', async () => {
    const { svc, prisma } = setup(promo());
    await svc.update('pr1', { isActive: false });
    expect(prisma.promotion.update.mock.calls[0][0].data).toEqual({ isActive: false });
    await expect(svc.update('pr1', { endsAt: '2026-10-01T00:00:00Z' })).rejects.toBeInstanceOf(BadRequestException);
    await svc.update('pr1', { endsAt: null });
    expect(prisma.promotion.update.mock.calls[1][0].data).toMatchObject({ endsAt: null });
    await expect(svc.update('pr1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a hand-set imageUrl replaces an uploaded image and removes its file', async () => {
    const { svc, storage } = setup(promo({ imagePath: 'promotions/pr1/old.jpg' }));
    await svc.update('pr1', { imageUrl: 'https://cdn.example.com/new.png' });
    expect(storage.removeFromBucket).toHaveBeenCalledWith('promotion-images', ['promotions/pr1/old.jpg']);
  });

  it('404s on unknown promotions; delete removes the uploaded file', async () => {
    const a = setup(null);
    await expect(a.svc.update('nope', { title: 'x y' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(a.svc.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    const b = setup(promo({ imagePath: 'promotions/pr1/a.jpg' }));
    await expect(b.svc.remove('pr1')).resolves.toEqual({ deleted: true });
    expect(b.storage.removeFromBucket).toHaveBeenCalledWith('promotion-images', ['promotions/pr1/a.jpg']);
  });
});

describe('popup image', () => {
  it('stores the image as WebP (max 1600 px) and replaces the old file', async () => {
    const { svc, storage, prisma } = setup(promo({ imagePath: 'promotions/pr1/old.jpg' }));
    await svc.setImage('pr1', { buffer: JPEG, size: JPEG.length });
    const [bucket, path, body, type] = storage.uploadPublic.mock.calls[0];
    expect(bucket).toBe('promotion-images');
    expect(path).toMatch(/^promotions\/pr1\/[0-9a-f-]{36}\.webp$/);
    expect(type).toBe('image/webp');
    expect(await sharp(body).metadata()).toMatchObject({ format: 'webp', width: 1600, height: 800 });
    expect(prisma.promotion.update.mock.calls[0][0].data.imageUrl).toMatch(/^https:\/\/x\/promotion-images\//);
    expect(storage.removeFromBucket).toHaveBeenCalledWith('promotion-images', ['promotions/pr1/old.jpg']);
  });

  it('refuses a missing file or a non-image', async () => {
    const { svc, storage } = setup(promo());
    await expect(svc.setImage('pr1', undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setImage('pr1', { buffer: Buffer.from('%PDF'), size: 4 })).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });
});

describe('announce (push to customers)', () => {
  it('pushes a live promotion once, as a PROMOTION the app can open', async () => {
    const { svc, notifications, prisma } = setup(promo());
    const out = await svc.announce('pr1');
    expect(prisma.promotion.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'pr1', announcedAt: null }, data: { announcedAt: NOW } });
    expect(notifications.broadcast).toHaveBeenCalledWith('CUSTOMERS', 'Black Friday', '20% off snacks', { type: 'PROMOTION', data: { promotionId: 'pr1' } });
    expect(out).toMatchObject({ promotionId: 'pr1', recipients: 42 });
  });

  it('refuses one that is not live, or announced in the last 12 hours, or a parallel click', async () => {
    for (const over of [{ isActive: false }, { startsAt: new Date('2026-12-01T00:00:00Z'), endsAt: null }, { announcedAt: new Date('2026-11-10T06:00:00Z') }]) {
      const { svc, notifications } = setup(promo(over));
      await expect(svc.announce('pr1')).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.broadcast).not.toHaveBeenCalled();
    }
    const race = setup(promo());
    race.prisma.promotion.updateMany.mockResolvedValue({ count: 0 });
    await expect(race.svc.announce('pr1')).rejects.toBeInstanceOf(ConflictException);
    expect(race.notifications.broadcast).not.toHaveBeenCalled();
  });

  it('can be announced again a day later; a failed push can be retried at once', async () => {
    const later = setup(promo({ announcedAt: new Date('2026-11-09T06:00:00Z') }));
    await expect(later.svc.announce('pr1')).resolves.toBeDefined();

    const failing = setup(promo());
    failing.notifications.broadcast.mockRejectedValue(new Error('db down'));
    await expect(failing.svc.announce('pr1')).rejects.toThrow('db down');
    expect(failing.prisma.promotion.updateMany.mock.calls[1][0]).toEqual({ where: { id: 'pr1', announcedAt: NOW }, data: { announcedAt: null } });
  });
});

describe('input validation and routes', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CreatePromotionDto });

  it('accepts a full promotion with a theme', async () => {
    await expect(check({
      title: ' Weekend deals ', subtitle: 'Up to 30% off', ctaType: 'CATEGORY', ctaValue: 'c1', ctaLabel: 'Shop now',
      theme: { background: '#0B1D51', accentColor: '#FFC83D', animation: 'float3d' }, frequency: 'DAILY', priority: 5,
      startsAt: '2026-11-14T00:00:00Z', endsAt: '2026-11-16T00:00:00Z',
    })).resolves.toMatchObject({ title: 'Weekend deals' });
  });

  it.each([
    [{ title: 'A' }],
    [{ title: 'Sale', theme: { background: 'blue' } }],
    [{ title: 'Sale', theme: { animation: 'explode' } }],
    [{ title: 'Sale', frequency: 'HOURLY' }],
    [{ title: 'Sale', startsAt: 'next week' }],
    [{ title: 'Sale', extra: 1 }],
  ])('rejects %p', async (body) => {
    await expect(check(body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the active list is public; every admin route is ADMIN only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PromotionsController)).toBeUndefined();
    expect(new Reflector().get(ROLES_KEY, AdminPromotionsController)).toEqual([StaffRole.ADMIN]);
  });
});
