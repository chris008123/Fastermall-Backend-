import { BadRequestException, NotFoundException, PayloadTooLargeException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import {
  ANIMATION_PRESETS,
  animationCatalogue,
  LEGACY_ANIMATIONS,
  legacyAnimation,
  toLegacy,
} from './animations';
import { checkLottie, LOTTIE_LIMITS } from './lottie';
import { normalizeTheme, PromotionsService } from './promotions.service';
import { PromotionsController } from './promotions.controller';
import { CreatePromotionDto, PromotionEventDto } from './dto/promotion.dto';

const NOW = new Date('2026-11-20T12:00:00Z');

// A minimal valid Lottie: 2 seconds at 30 fps, 200 x 100, one layer.
const lottie = (over: Record<string, unknown> = {}) => ({
  v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 100, nm: 'promo', layers: [{ ty: 4, nm: 'shape', ks: {} }],
  ...over,
});
const file = (data: unknown, size?: number) => {
  const buffer = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return { buffer, size: size ?? buffer.length, mimetype: 'application/json', originalname: 'promo.json' } as any;
};

function setup(row: any = { id: 'pr1', lottiePath: null }) {
  const prisma: any = {
    promotion: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn(({ data }) => Promise.resolve({ id: 'pr1', isActive: true, startsAt: NOW, endsAt: null, viewCount: 0, clickCount: 0, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const storage = {
    uploadPublic: jest.fn((bucket: string, path: string, _body?: Buffer, _type?: string) => Promise.resolve({ path, publicUrl: `https://x/${bucket}/${path}` })),
    removeFromBucket: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new PromotionsService(prisma, storage as any, { get: () => undefined } as any);
  (svc as any).now = () => NOW;
  return { svc, prisma, storage };
}

describe('animation catalogue', () => {
  it('every preset has a unique key, and every fallback chain ends at a preset all apps know', () => {
    const keys = ANIMATION_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of ANIMATION_PRESETS) {
      expect(LEGACY_ANIMATIONS).toContain(toLegacy(p.key));
      if (p.fallback) expect(keys).toContain(p.fallback);
    }
  });

  it('keeps the six presets released on 10 Nov as the legacy list', () => {
    expect([...LEGACY_ANIMATIONS].sort()).toEqual(['bounce', 'confetti', 'fade', 'float3d', 'none', 'slide']);
  });

  it('maps new presets to ones older apps can play; unknown names become fade', () => {
    expect(toLegacy('snow')).toBe('confetti');
    expect(toLegacy('zoom')).toBe('fade');
    expect(toLegacy('pulse')).toBe('bounce');
    expect(toLegacy('float3d')).toBe('float3d');
    expect(toLegacy('none')).toBe('none');
    expect(toLegacy('explode')).toBe('fade');
  });

  it('GET /promotions/animations lists presets, limits and the app rules, publicly', () => {
    const c = animationCatalogue();
    expect(c.presets).toBe(ANIMATION_PRESETS);
    expect(Object.keys(c.rules)).toEqual(['unknownPreset', 'reduceMotion', 'lowEndDevice', 'lottie', 'olderApps']);
    expect(new PromotionsController({} as any).animations()).toEqual(c);
    expect(Reflect.getMetadata(GUARDS_METADATA, PromotionsController)).toBeUndefined();
  });
});

describe('theme for older apps', () => {
  it('an animation the admin set is kept', () => {
    expect(legacyAnimation({ animation: 'bounce', effect: { preset: 'snow' } })).toBe('bounce');
  });

  it('otherwise the most visible part decides: effect, then loop, then entrance', () => {
    expect(legacyAnimation({ entrance: { preset: 'slide' }, effect: { preset: 'snow' } })).toBe('confetti');
    expect(legacyAnimation({ entrance: { preset: 'zoom' }, loop: { preset: 'float3d' } })).toBe('float3d');
    expect(legacyAnimation({ entrance: { preset: 'zoom' } })).toBe('fade');
    expect(legacyAnimation({ entrance: { preset: 'none' }, effect: { preset: 'none' } })).toBe('none');
    expect(legacyAnimation({})).toBeUndefined();
  });

  it('normalizeTheme stores a plain object with animation filled in', () => {
    expect(normalizeTheme({ background: '#000000', effect: { preset: 'sparkle' } } as any)).toEqual({
      background: '#000000', effect: { preset: 'sparkle' }, animation: 'confetti',
    });
    expect(normalizeTheme({ background: '#000000' } as any)).toEqual({ background: '#000000' });
    expect(normalizeTheme(null)).toBe(Prisma.JsonNull);
    expect(normalizeTheme(undefined)).toBe(Prisma.JsonNull);
  });
});

describe('theme validation', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (theme: unknown) => pipe.transform({ title: 'Sale', theme }, { type: 'body', metatype: CreatePromotionDto });

  it('accepts entrance, effect, loop and Lottie settings', async () => {
    await expect(check({
      accentColor: '#FFC83D',
      entrance: { preset: 'slide', direction: 'up', durationMs: 500, delayMs: 200 },
      effect: { preset: 'snow', colors: ['#FFFFFF', '#C0E0FF'], durationMs: 4000 },
      loop: { preset: 'pulse', intensity: 'low' },
      lottie: { loop: true, speed: 1.5, placement: 'hero' },
    })).resolves.toBeDefined();
  });

  it.each([
    ['accent instead of accentColor', { accent: '#FFC83D' }],
    ['a new preset in the legacy field', { animation: 'snow' }],
    ['an effect used as an entrance', { entrance: { preset: 'confetti' } }],
    ['an unknown preset', { effect: { preset: 'fireworks' } }],
    ['a part without a preset', { loop: { intensity: 'low' } }],
    ['an entrance that is too slow', { entrance: { preset: 'fade', durationMs: 10_000 } }],
    ['a bad slide direction', { entrance: { preset: 'slide', direction: 'diagonal' } }],
    ['too many effect colours', { effect: { preset: 'confetti', colors: Array(7).fill('#FFFFFF') } }],
    ['a colour that is not hex', { effect: { preset: 'confetti', colors: ['red'] } }],
    ['a Lottie speed out of range', { lottie: { speed: 10 } }],
    ['an unknown Lottie placement', { lottie: { placement: 'fullscreen' } }],
    ['an unknown key inside a part', { loop: { preset: 'pulse', speed: 2 } }],
  ])('rejects %s', async (_name, theme) => {
    await expect(check(theme)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('events accept VIEW, CLICK and DISMISS only', async () => {
    const ev = (body: unknown) => pipe.transform(body, { type: 'body', metatype: PromotionEventDto });
    await expect(ev({ type: 'CLICK' })).resolves.toEqual({ type: 'CLICK' });
    await expect(ev({ type: 'SHARE' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Lottie file check', () => {
  const code = (data: unknown) => {
    try {
      checkLottie(Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)));
    } catch (e) {
      return ((e as BadRequestException).getResponse() as any).code;
    }
    return 'OK';
  };

  it('accepts a valid animation, minifies it and reports its size and length', () => {
    const raw = Buffer.from('﻿' + JSON.stringify(lottie(), null, 2));
    const { json, info } = checkLottie(raw);
    expect(JSON.parse(json.toString())).toEqual(lottie());
    expect(json.length).toBeLessThan(raw.length);
    expect(info).toEqual({ width: 200, height: 100, frameRate: 30, durationMs: 2000, bytes: json.length });
  });

  it('accepts embedded images and precompositions', () => {
    expect(code(lottie({ assets: [
      { id: 'img', w: 10, h: 10, e: 1, u: '', p: 'data:image/png;base64,iVBORw0KGgo=' },
      { id: 'comp', layers: [] },
    ] }))).toBe('OK');
  });

  it.each([
    ['not JSON', '{nope', 'INVALID_LOTTIE'],
    ['a .lottie zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'LOTTIE_ZIP_NOT_SUPPORTED'],
    ['a JSON list', [1, 2], 'INVALID_LOTTIE'],
    ['JSON that is not Lottie', { hello: 'world' }, 'INVALID_LOTTIE'],
    ['no layers', lottie({ layers: [] }), 'INVALID_LOTTIE'],
    ['no frames', lottie({ op: 0 }), 'INVALID_LOTTIE'],
    ['a zero frame rate', lottie({ fr: 0 }), 'INVALID_LOTTIE'],
    ['too wide', lottie({ w: LOTTIE_LIMITS.maxDimension + 1 }), 'LOTTIE_TOO_LARGE'],
    ['too long', lottie({ op: 30 * 31 }), 'LOTTIE_TOO_LONG'],
    ['too many layers', lottie({ layers: Array(LOTTIE_LIMITS.maxLayers + 1).fill({ ty: 4 }) }), 'LOTTIE_TOO_COMPLEX'],
    ['an image loaded from a server', lottie({ assets: [{ id: 'i', e: 0, u: 'https://evil.example/', p: 'a.png' }] }), 'LOTTIE_EXTERNAL_ASSETS'],
    ['an embedded SVG', lottie({ assets: [{ id: 'i', e: 1, u: '', p: 'data:image/svg+xml;base64,PHN2Zz4=' }] }), 'LOTTIE_EXTERNAL_ASSETS'],
    ['an expression', lottie({ layers: [{ ty: 4, ks: { o: { a: 0, k: 100, x: 'var $bm_rt = 1;' } } }] }), 'LOTTIE_EXPRESSIONS'],
  ])('refuses %s', (_name, data, expected) => {
    expect(code(data)).toBe(expected);
  });

  it('refuses a tree nested too deeply', () => {
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < LOTTIE_LIMITS.maxDepth + 5; i++) deep = deep.n = {};
    expect(code(lottie({ layers: [root] }))).toBe('LOTTIE_TOO_COMPLEX');
  });
});

describe('Lottie upload', () => {
  it('stores the minified file in the promotion bucket and saves its URL and facts', async () => {
    const { svc, prisma, storage } = setup();
    const res = await svc.setLottie('pr1', file(lottie()));
    const [bucket, path, body, type] = storage.uploadPublic.mock.calls[0];
    expect(bucket).toBe('promotion-images');
    expect(path).toMatch(/^promotions\/pr1\/[0-9a-f-]+\.json$/);
    expect(type).toBe('application/json');
    expect(JSON.parse((body as Buffer).toString())).toEqual(lottie());
    expect(prisma.promotion.update.mock.calls[0][0].data).toMatchObject({
      lottieUrl: `https://x/promotion-images/${path}`,
      lottiePath: path,
      lottieInfo: { width: 200, height: 100, frameRate: 30, durationMs: 2000 },
    });
    expect(res).toMatchObject({ lottiePath: path, status: 'live', clickRate: null });
    expect(storage.removeFromBucket).not.toHaveBeenCalled();
  });

  it('replaces the old file', async () => {
    const { svc, storage } = setup({ id: 'pr1', lottiePath: 'promotions/pr1/old.json' });
    await svc.setLottie('pr1', file(lottie()));
    expect(storage.removeFromBucket).toHaveBeenCalledWith('promotion-images', ['promotions/pr1/old.json']);
  });

  it('removes the new file if saving the promotion fails', async () => {
    const { svc, prisma, storage } = setup();
    prisma.promotion.update.mockRejectedValue(new Error('db down'));
    await expect(svc.setLottie('pr1', file(lottie()))).rejects.toThrow('db down');
    expect(storage.removeFromBucket.mock.calls[0][1][0]).toMatch(/^promotions\/pr1\/.+\.json$/);
  });

  it('refuses a missing, oversized or invalid file before uploading anything', async () => {
    const { svc, storage } = setup();
    await expect(svc.setLottie('pr1', undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setLottie('pr1', file(lottie(), 600 * 1024))).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(svc.setLottie('pr1', file({ hello: 1 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });

  it('404s on an unknown promotion', async () => {
    const { svc } = setup(null);
    await expect(svc.setLottie('nope', file(lottie()))).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.removeLottie('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removing it clears the fields and deletes the file', async () => {
    const { svc, prisma, storage } = setup({ id: 'pr1', lottiePath: 'promotions/pr1/a.json' });
    await svc.removeLottie('pr1');
    expect(prisma.promotion.update.mock.calls[0][0].data).toEqual({ lottieUrl: null, lottiePath: null, lottieInfo: Prisma.JsonNull });
    expect(storage.removeFromBucket).toHaveBeenCalledWith('promotion-images', ['promotions/pr1/a.json']);
  });

  it('deleting the promotion deletes its image and its animation', async () => {
    const { svc, storage } = setup({ imagePath: 'promotions/pr1/i.webp', lottiePath: 'promotions/pr1/a.json' });
    await svc.remove('pr1');
    expect(storage.removeFromBucket).toHaveBeenCalledWith('promotion-images', ['promotions/pr1/i.webp', 'promotions/pr1/a.json']);
  });
});

describe('preview and counters', () => {
  it('preview returns the app view of any promotion, with its status', async () => {
    const row = { id: 'pr1', title: 'Xmas', isActive: true, startsAt: new Date('2026-12-01T00:00:00Z'), endsAt: null, lottieUrl: 'https://x/a.json' };
    const { svc, prisma } = setup(row);
    const res = await svc.preview('pr1');
    expect(res.status).toBe('scheduled');
    expect(res.promotion).not.toHaveProperty('isActive');
    const select = prisma.promotion.findUnique.mock.calls[0][0].select;
    expect(select).toMatchObject({ lottieUrl: true, lottieInfo: true, theme: true });
    expect(select).not.toHaveProperty('viewCount');
    expect(select).not.toHaveProperty('lottiePath');
  });

  it('counts an event only while the promotion is live', async () => {
    const { svc, prisma } = setup();
    await expect(svc.recordEvent('pr1', 'CLICK')).resolves.toEqual({ recorded: true });
    const arg = prisma.promotion.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ id: 'pr1', isActive: true, startsAt: { lte: NOW } });
    expect(arg.data).toEqual({ clickCount: { increment: 1 } });

    prisma.promotion.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.recordEvent('ended', 'VIEW')).resolves.toEqual({ recorded: false });
  });

  it('the admin view shows the click rate', async () => {
    const { svc } = setup({ id: 'pr1', isActive: true, startsAt: NOW, endsAt: null, viewCount: 300, clickCount: 45 });
    await expect(svc.findOne('pr1')).resolves.toMatchObject({ viewCount: 300, clickCount: 45, clickRate: 0.15 });
  });

  it('the events route is public and rate-limited', () => {
    const reflector = new Reflector();
    const handler = PromotionsController.prototype.event;
    expect(reflector.get('THROTTLER:LIMITdefault', handler)).toBe(30);
  });
});
