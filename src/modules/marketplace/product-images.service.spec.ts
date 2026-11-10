import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import { ProductImagesService, sniffImageType } from './product-images.service';
import { ProductImagesController } from './product-images.controller';
import { MarketplaceService } from './marketplace.service';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7 not an image');
const file = (buffer: Buffer, originalname = 'photo.jpg', mimetype = 'image/jpeg') => ({ buffer, size: buffer.length, originalname, mimetype });

describe('sniffImageType', () => {
  it('reads the type from the bytes, not the name', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(PDF)).toBeNull();
    expect(sniffImageType(Buffer.from('<svg></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

function setup(existing: any[] = [], cfg: Record<string, unknown> = {}) {
  let rows = existing.map((r) => ({ ...r }));
  const prisma: any = {
    product: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', imageUrl: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    productImage: {
      count: jest.fn(() => Promise.resolve(rows.length)),
      aggregate: jest.fn(() => Promise.resolve({ _max: { sortOrder: rows.length ? Math.max(...rows.map((r) => r.sortOrder)) : null } })),
      createMany: jest.fn(({ data }) => {
        rows.push(...data.map((d: any, i: number) => ({ id: `new${rows.length + i}`, ...d })));
        return Promise.resolve({ count: data.length });
      }),
      findMany: jest.fn(({ select }: any) => {
        const sorted = [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
        return Promise.resolve(select?.path && !select?.url ? sorted.map((r) => ({ path: r.path })) : sorted);
      }),
      findFirst: jest.fn(({ where }) => Promise.resolve(rows.find((r) => r.id === where.id && r.productId === where.productId) ?? null)),
      delete: jest.fn(({ where }) => {
        rows = rows.filter((r) => r.id !== where.id);
        return Promise.resolve({});
      }),
      update: jest.fn(({ where, data }) => {
        const r = rows.find((x) => x.id === where.id);
        Object.assign(r, data);
        return Promise.resolve(r);
      }),
    },
    $transaction: jest.fn((ops: any) => Promise.all(ops)),
  };
  let n = 0;
  const storage = {
    uploadPublic: jest.fn((bucket: string, path: string, _body?: Buffer, _type?: string) =>
      Promise.resolve({ path, publicUrl: `https://x.supabase.co/storage/v1/object/public/${bucket}/${path}#${n++}` }),
    ),
    removeFromBucket: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: (k: string) => cfg[k] };
  return { svc: new ProductImagesService(prisma, storage as any, config as any), prisma, storage, rows: () => rows };
}

const stored = (id: string, sortOrder: number) => ({
  id,
  productId: 'p1',
  url: `https://x.supabase.co/storage/v1/object/public/product-images/products/p1/${id}.jpg`,
  path: `products/p1/${id}.jpg`,
  sortOrder,
  contentType: 'image/jpeg',
  sizeBytes: 10,
});

describe('ProductImagesService.add', () => {
  it('stores each photo under the product with its real type, and makes the first the main image', async () => {
    const { svc, storage, prisma } = setup();
    const out = await svc.add('p1', [file(JPEG), file(PNG, 'b.png'), file(WEBP, 'renamed.jpg', 'image/jpeg')]);

    const calls = storage.uploadPublic.mock.calls;
    expect(calls.map((c) => [c[0], c[3]])).toEqual([
      ['product-images', 'image/jpeg'],
      ['product-images', 'image/png'],
      ['product-images', 'image/webp'], // from the bytes, not the name or mimetype
    ]);
    expect(calls[0][1]).toMatch(/^products\/p1\/[0-9a-f-]{36}\.jpg$/);
    expect(calls[2][1]).toMatch(/\.webp$/);
    expect(out.images.map((i: any) => i.sortOrder)).toEqual([0, 1, 2]);
    expect(prisma.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { imageUrl: out.images[0].url } });
    expect(out.imageUrl).toBe(out.images[0].url);
  });

  it('adds after the existing photos', async () => {
    const { svc } = setup([stored('a', 0), stored('b', 1)]);
    const out = await svc.add('p1', [file(JPEG)]);
    expect(out.images.map((i: any) => i.sortOrder)).toEqual([0, 1, 2]);
    expect(out.imageUrl).toContain('/a.jpg'); // the main image does not change
  });

  it('refuses a non-image, an oversized file, or going over the limit, uploading nothing', async () => {
    const a = setup();
    const err: any = await a.svc.add('p1', [file(JPEG), file(PDF, 'cv.jpg')]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE', message: expect.stringContaining('cv.jpg') });

    const b = setup([], { 'productImages.maxBytes': 5 });
    await expect(b.svc.add('p1', [file(JPEG)])).rejects.toBeInstanceOf(PayloadTooLargeException);

    const c = setup([stored('a', 0), stored('b', 1), stored('c', 2), stored('d', 3)]);
    const tooMany: any = await c.svc.add('p1', [file(JPEG), file(PNG)]).catch((e) => e);
    expect(tooMany).toBeInstanceOf(ConflictException);
    expect(tooMany.getResponse().code).toBe('TOO_MANY_IMAGES');

    for (const s of [a, b, c]) expect(s.storage.uploadPublic).not.toHaveBeenCalled();
  });

  it('needs at least one file, and an existing product', async () => {
    const { svc, prisma } = setup();
    await expect(svc.add('p1', [])).rejects.toBeInstanceOf(BadRequestException);
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(svc.add('nope', [file(JPEG)])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes already-uploaded files if a later upload fails, and records nothing', async () => {
    const { svc, storage, prisma } = setup();
    storage.uploadPublic
      .mockResolvedValueOnce({ path: 'products/p1/one.jpg', publicUrl: 'u1' })
      .mockRejectedValueOnce(new ServiceUnavailableException('down'));
    await expect(svc.add('p1', [file(JPEG), file(PNG)])).rejects.toBeInstanceOf(ServiceUnavailableException);
    const firstPath = storage.uploadPublic.mock.calls[0][1];
    expect(storage.removeFromBucket).toHaveBeenCalledWith('product-images', [firstPath]);
    expect(prisma.productImage.createMany).not.toHaveBeenCalled();
  });
});

describe('ProductImagesService remove and reorder', () => {
  it('removing the main photo makes the next one main, and deletes the file', async () => {
    const { svc, storage, prisma } = setup([stored('a', 0), stored('b', 1)]);
    const out = await svc.remove('p1', 'a');
    expect(storage.removeFromBucket).toHaveBeenCalledWith('product-images', ['products/p1/a.jpg']);
    expect(out.images.map((i: any) => i.id)).toEqual(['b']);
    expect(prisma.product.update).toHaveBeenLastCalledWith({ where: { id: 'p1' }, data: { imageUrl: expect.stringContaining('/b.jpg') } });
  });

  it('removing the last photo clears imageUrl; an external URL set by hand is kept', async () => {
    const a = setup([stored('a', 0)]);
    a.prisma.product.findUnique.mockResolvedValue({ id: 'p1', imageUrl: stored('a', 0).url });
    expect((await a.svc.remove('p1', 'a')).imageUrl).toBeNull();

    const b = setup([stored('a', 0)]);
    b.prisma.product.findUnique.mockResolvedValue({ id: 'p1', imageUrl: 'https://cdn.example.com/hand-set.jpg' });
    expect((await b.svc.remove('p1', 'a')).imageUrl).toBe('https://cdn.example.com/hand-set.jpg');
  });

  it("404s on another product's image", async () => {
    const { svc } = setup([stored('a', 0)]);
    await expect(svc.remove('p2', 'a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reorders: the first listed becomes the main image', async () => {
    const { svc } = setup([stored('a', 0), stored('b', 1), stored('c', 2)]);
    const out = await svc.reorder('p1', ['c', 'a', 'b']);
    expect(out.images.map((i: any) => i.id)).toEqual(['c', 'a', 'b']);
    expect(out.imageUrl).toContain('/c.jpg');
  });

  it.each([[['a', 'b']], [['a', 'b', 'c', 'c']], [['a', 'b', 'x']]])('refuses an order that is not every image exactly once: %p', async (ids) => {
    const { svc } = setup([stored('a', 0), stored('b', 1), stored('c', 2)]);
    await expect(svc.reorder('p1', ids)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('deleting a product removes its photo files', () => {
  it('reads the paths before the delete (the rows cascade), then removes the files', async () => {
    const order: string[] = [];
    const prisma: any = {
      product: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
        delete: jest.fn(() => {
          order.push('delete');
          return Promise.resolve({});
        }),
      },
    };
    const images = {
      pathsOf: jest.fn(() => {
        order.push('paths');
        return Promise.resolve(['products/p1/a.jpg']);
      }),
      removeFiles: jest.fn(() => {
        order.push('remove');
        return Promise.resolve();
      }),
    };
    await new MarketplaceService(prisma, images as any).deleteProduct('p1');
    expect(order).toEqual(['paths', 'delete', 'remove']);
    expect(images.removeFiles).toHaveBeenCalledWith(['products/p1/a.jpg']);
  });
});

describe('ProductImagesController', () => {
  it.each(['upload', 'reorder', 'remove'])('%s is ADMIN only', (name) => {
    const handler = (ProductImagesController.prototype as any)[name];
    expect(new Reflector().get(ROLES_KEY, handler)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });

  it('listing is public', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ProductImagesController.prototype.list)).toBeUndefined();
  });
});
