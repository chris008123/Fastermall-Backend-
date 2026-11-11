import { BadRequestException, ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import { PreOrdersService } from './preorders.service';
import { AdminPreOrdersController, PreOrdersController } from './preorders.controller';
import { CreatePreOrderDto, QuotePreOrderDto } from './dto/preorder.dto';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';

const NOW = new Date('2026-11-11T10:00:00Z');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

function setup(request: any = null) {
  const row = request && { images: [], product: null, variant: null, ...request };
  const prisma: any = {
    product: { findUnique: jest.fn().mockResolvedValue({ id: 'shoe', allowsPreOrder: true }) },
    productVariant: {
      findFirst: jest.fn().mockResolvedValue({ id: 'black' }),
      create: jest.fn(({ data }) => Promise.resolve({ id: 'v1', ...data })),
      update: jest.fn(({ data }) => Promise.resolve({ id: 'v1', ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
    preOrderRequest: {
      create: jest.fn(({ data }) => Promise.resolve({ id: 'pre1', images: [], product: null, variant: null, ...data })),
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue(row ? [row] : []),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    preOrderImage: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const storage = {
    uploadPrivate: jest.fn((_b: string, path: string, _body?: Buffer, _t?: string) => Promise.resolve({ path })),
    signedUrls: jest.fn((_b: string, paths: string[]) => Promise.resolve(paths.map((p) => `https://signed/${p}?token=x`))),
    removeFromBucket: jest.fn().mockResolvedValue(undefined),
  };
  const events = { emit: jest.fn() };
  const svc = new PreOrdersService(prisma, storage as any, { get: () => undefined } as any, events as any);
  (svc as any).now = () => NOW;
  return { svc, prisma, storage, events };
}

describe('customer: making a request', () => {
  it('a design of a pre-orderable product, with specifications', async () => {
    const { svc, prisma, events } = setup();
    await svc.create('c1', {
      productId: 'shoe', variantId: 'black', quantity: 2,
      description: 'Black leather sneakers like the photo, but with a white sole',
      specifications: { Size: '42', ' Colour ': ' black ' },
    });
    expect(prisma.productVariant.findFirst.mock.calls[0][0].where).toEqual({ id: 'black', productId: 'shoe', isActive: true });
    expect(prisma.preOrderRequest.create.mock.calls[0][0].data).toMatchObject({
      customerId: 'c1', productId: 'shoe', variantId: 'black', quantity: 2, specifications: { Size: '42', Colour: 'black' },
    });
    expect(events.emit).toHaveBeenCalledWith('preorder.submitted', { requestId: 'pre1', customerId: 'c1' });
  });

  it('a fully custom request needs no product', async () => {
    const { svc, prisma } = setup();
    await svc.create('c1', { description: 'A kente-pattern laptop sleeve for a 14 inch laptop' });
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(prisma.preOrderRequest.create.mock.calls[0][0].data).toMatchObject({ productId: null, variantId: null, quantity: 1 });
  });

  it('refuses a product that cannot be pre-ordered, an unknown design, or a design without its product', async () => {
    const a = setup();
    a.prisma.product.findUnique.mockResolvedValue({ id: 'shoe', allowsPreOrder: false });
    await expect(a.svc.create('c1', { productId: 'shoe', description: 'x'.repeat(12) })).rejects.toMatchObject({ response: { code: 'PREORDER_NOT_ALLOWED' } });

    const b = setup();
    b.prisma.productVariant.findFirst.mockResolvedValue(null);
    await expect(b.svc.create('c1', { productId: 'shoe', variantId: 'pink', description: 'x'.repeat(12) })).rejects.toMatchObject({ response: { code: 'INVALID_VARIANT' } });

    const c = setup();
    await expect(c.svc.create('c1', { variantId: 'black', description: 'x'.repeat(12) })).rejects.toBeInstanceOf(BadRequestException);
    c.prisma.product.findUnique.mockResolvedValue(null);
    await expect(c.svc.create('c1', { productId: 'nope', description: 'x'.repeat(12) })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('specifications must be short label -> text pairs', async () => {
    const { svc } = setup();
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    for (const specifications of [many, { Size: { nested: true } }, { '': 'x' }, { Note: 'y'.repeat(201) }]) {
      await expect(svc.create('c1', { description: 'x'.repeat(12), specifications: specifications as any })).rejects.toMatchObject({
        response: { code: 'INVALID_SPECIFICATIONS' },
      });
    }
  });
});

describe('customer: reference photos (private)', () => {
  const submitted = { id: 'pre1', customerId: 'c1', status: 'SUBMITTED', _count: { images: 0 } };

  it('stores real images privately and returns short-lived links', async () => {
    const { svc, storage, prisma } = setup(submitted);
    prisma.preOrderRequest.findFirst
      .mockResolvedValueOnce(submitted)
      .mockResolvedValueOnce({ ...submitted, images: [{ id: 'i1', path: 'preorders/pre1/a.jpg', contentType: 'image/jpeg', createdAt: NOW }], product: null, variant: null });
    const out: any = await svc.addImages('c1', 'pre1', [{ buffer: JPEG, size: JPEG.length }]);
    expect(storage.uploadPrivate.mock.calls[0][0]).toBe('preorder-references');
    expect(storage.uploadPrivate.mock.calls[0][1]).toMatch(/^preorders\/pre1\/[0-9a-f-]{36}\.jpg$/);
    expect(out.images).toEqual([{ id: 'i1', contentType: 'image/jpeg', createdAt: NOW, url: 'https://signed/preorders/pre1/a.jpg?token=x' }]);
    expect(JSON.stringify(out)).not.toContain('"path"'); // the storage path is never sent
  });

  it('refuses after the quote, too many photos, non-images, or someone else’s request', async () => {
    const a = setup({ ...submitted, status: 'QUOTED' });
    await expect(a.svc.addImages('c1', 'pre1', [{ buffer: JPEG, size: 6 }])).rejects.toMatchObject({ response: { code: 'PREORDER_LOCKED' } });
    const b = setup({ ...submitted, _count: { images: 5 } });
    await expect(b.svc.addImages('c1', 'pre1', [{ buffer: JPEG, size: 6 }])).rejects.toMatchObject({ response: { code: 'TOO_MANY_IMAGES' } });
    const c = setup(submitted);
    await expect(c.svc.addImages('c1', 'pre1', [{ buffer: Buffer.from('%PDF'), size: 4 }])).rejects.toMatchObject({ response: { code: 'UNSUPPORTED_IMAGE_TYPE' } });
    const d = setup(null);
    await expect(d.svc.addImages('intruder', 'pre1', [{ buffer: JPEG, size: 6 }])).rejects.toBeInstanceOf(NotFoundException);
    for (const s of [a, b, c, d]) expect(s.storage.uploadPrivate).not.toHaveBeenCalled();
  });

  it('a photo link that cannot be signed does not hide the request', async () => {
    const { svc, storage } = setup({ id: 'pre1', customerId: 'c1', status: 'SUBMITTED', images: [{ id: 'i1', path: 'p', contentType: 'image/png', createdAt: NOW }] });
    storage.signedUrls.mockRejectedValue(new Error('storage down'));
    await expect(svc.findMine('c1', 'pre1')).resolves.toMatchObject({ images: [{ id: 'i1', url: null }] });
  });
});

describe('quote -> accept/decline -> fulfil', () => {
  it('admin quotes (or re-quotes) a price and a future date; the customer is told', async () => {
    const { svc, prisma, events } = setup({ id: 'pre1', customerId: 'c1', status: 'SUBMITTED' });
    await svc.quote('pre1', { price: 450, estimatedDate: '2026-11-25T00:00:00Z', note: 'Leather from Kumasi' });
    const call = prisma.preOrderRequest.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'pre1', status: { in: ['SUBMITTED', 'QUOTED'] } });
    expect(call.data).toMatchObject({ status: 'QUOTED', estimatedDate: new Date('2026-11-25T00:00:00Z'), quotedAt: NOW, adminNote: 'Leather from Kumasi' });
    expect(String(call.data.quotedPrice)).toBe('450');
    expect(events.emit).toHaveBeenCalledWith('preorder.quoted', expect.objectContaining({ requestId: 'pre1', customerId: 'c1', price: 450 }));

    await expect(svc.quote('pre1', { price: 450, estimatedDate: '2026-11-01T00:00:00Z' })).rejects.toMatchObject({ response: { code: 'INVALID_DATE' } });
  });

  it('the customer accepts or declines only a quoted request', async () => {
    const quoted = setup({ id: 'pre1', customerId: 'c1', status: 'QUOTED' });
    await quoted.svc.accept('c1', 'pre1');
    expect(quoted.prisma.preOrderRequest.updateMany.mock.calls[0][0]).toMatchObject({ where: { status: { in: ['QUOTED'] } }, data: { status: 'ACCEPTED', decidedAt: NOW } });
    expect(quoted.events.emit).toHaveBeenCalledWith('preorder.customer.decided', { requestId: 'pre1', customerId: 'c1', status: 'ACCEPTED' });

    await quoted.svc.decline('c1', 'pre1', 'Too expensive');
    expect(quoted.prisma.preOrderRequest.updateMany.mock.calls[1][0].data).toMatchObject({ status: 'DECLINED', customerNote: 'Too expensive' });

    const notYet = setup({ id: 'pre1', customerId: 'c1', status: 'SUBMITTED' });
    await expect(notYet.svc.accept('c1', 'pre1')).rejects.toMatchObject({ response: { code: 'INVALID_PREORDER_STATUS' } });
    expect(notYet.prisma.preOrderRequest.updateMany).not.toHaveBeenCalled();
  });

  it('the customer can cancel before accepting, not after', async () => {
    await expect(setup({ id: 'pre1', customerId: 'c1', status: 'SUBMITTED' }).svc.cancel('c1', 'pre1')).resolves.toBeDefined();
    await expect(setup({ id: 'pre1', customerId: 'c1', status: 'QUOTED' }).svc.cancel('c1', 'pre1')).resolves.toBeDefined();
    await expect(setup({ id: 'pre1', customerId: 'c1', status: 'ACCEPTED' }).svc.cancel('c1', 'pre1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('admin fulfils only accepted requests, and can cancel anything not finished', async () => {
    const accepted = setup({ id: 'pre1', customerId: 'c1', status: 'ACCEPTED' });
    await accepted.svc.adminSetStatus('pre1', { status: 'FULFILLED', note: 'Pick up at the Legon shop' });
    expect(accepted.events.emit).toHaveBeenCalledWith('preorder.status.updated', expect.objectContaining({ status: 'FULFILLED' }));

    await expect(setup({ id: 'pre1', customerId: 'c1', status: 'QUOTED' }).svc.adminSetStatus('pre1', { status: 'FULFILLED' })).rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ id: 'pre1', customerId: 'c1', status: 'ACCEPTED' }).svc.adminSetStatus('pre1', { status: 'CANCELLED' })).resolves.toBeDefined();
    await expect(setup({ id: 'pre1', customerId: 'c1', status: 'FULFILLED' }).svc.adminSetStatus('pre1', { status: 'CANCELLED' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('two clicks at once: only one wins (409 PREORDER_CHANGED)', async () => {
    const { svc, prisma, events } = setup({ id: 'pre1', customerId: 'c1', status: 'QUOTED' });
    prisma.preOrderRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.accept('c1', 'pre1')).rejects.toMatchObject({ response: { code: 'PREORDER_CHANGED' } });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a customer only ever sees their own requests", async () => {
    const { svc, prisma } = setup(null);
    await expect(svc.findMine('intruder', 'pre1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.preOrderRequest.findFirst.mock.calls[0][0].where).toEqual({ id: 'pre1', customerId: 'intruder' });
  });
});

describe('product designs (variants)', () => {
  it('admins add, edit and remove designs; image links must be https', async () => {
    const { svc, prisma } = setup();
    await svc.createVariant('shoe', { name: 'Black leather', priceDelta: 50 });
    expect(prisma.productVariant.create.mock.calls[0][0].data).toMatchObject({ productId: 'shoe', name: 'Black leather', priceDelta: 50, isActive: true });
    await expect(svc.createVariant('shoe', { name: 'Red', imageUrl: 'http://x/y.jpg' })).rejects.toBeInstanceOf(BadRequestException);
    await svc.updateVariant('v1', { isActive: false });
    await expect(svc.updateVariant('v1', {})).rejects.toBeInstanceOf(BadRequestException);
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(svc.createVariant('nope', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('input validation and routes', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown, metatype: any) => pipe.transform(body, { type: 'body', metatype });

  it('a request needs a real description; a quote needs a positive price and a date', async () => {
    await expect(check({ description: 'too short' }, CreatePreOrderDto)).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ description: 'Black sneakers, size 42', quantity: 50 }, CreatePreOrderDto)).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ description: 'Black sneakers, size 42', quantity: 2 }, CreatePreOrderDto)).resolves.toBeDefined();
    await expect(check({ price: 0, estimatedDate: '2026-12-01T00:00:00Z' }, QuotePreOrderDto)).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ price: 100, estimatedDate: 'soon' }, QuotePreOrderDto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('customer routes need login; admin routes are ADMIN only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PreOrdersController)).toBeDefined();
    expect(new Reflector().get(ROLES_KEY, PreOrdersController)).toBeUndefined();
    expect(new Reflector().get(ROLES_KEY, AdminPreOrdersController)).toEqual([StaffRole.ADMIN]);
  });
});
