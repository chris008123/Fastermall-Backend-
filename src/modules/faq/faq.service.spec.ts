import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ValidationPipe } from '@nestjs/common';
import { Prisma, StaffRole } from '@prisma/client';
import { FaqService } from './faq.service';
import { AdminFaqController, FaqController } from './faq.controller';
import { CreateFaqDto, UpdateFaqDto } from './dto/faq.dto';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

function setup() {
  const prisma: any = {
    faq: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'f1', ...data })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'f1', ...data })),
      delete: jest.fn().mockResolvedValue({ id: 'f1' }),
    },
  };
  return { svc: new FaqService(prisma), prisma };
}

describe('FaqService.listPublished', () => {
  it('shows only published questions, in category then admin order, without admin fields', async () => {
    const { svc, prisma } = setup();
    await svc.listPublished();
    const arg = prisma.faq.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isPublished: true });
    expect(arg.orderBy).toEqual([
      { category: { sort: 'asc', nulls: 'last' } },
      { sortOrder: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ]);
    expect(arg.select).not.toHaveProperty('isPublished');
  });

  it('filters by category when asked', async () => {
    const { svc, prisma } = setup();
    await svc.listPublished('Payments');
    expect(prisma.faq.findMany.mock.calls[0][0].where).toEqual({ isPublished: true, category: 'Payments' });
  });

  it('returns the flat list and the same items grouped by category, in order', async () => {
    const { svc, prisma } = setup();
    const rows = [
      { id: 'a', category: 'Orders', question: 'Q1' },
      { id: 'b', category: 'Orders', question: 'Q2' },
      { id: 'c', category: 'Payments', question: 'Q3' },
      { id: 'd', category: null, question: 'Q4' },
    ];
    prisma.faq.findMany.mockResolvedValue(rows);
    const out = await svc.listPublished();
    expect(out.items).toBe(rows);
    expect(out.categories).toEqual([
      { name: 'Orders', items: [rows[0], rows[1]] },
      { name: 'Payments', items: [rows[2]] },
      { name: null, items: [rows[3]] },
    ]);
  });
});

describe('FaqService admin', () => {
  it('lists everything, including unpublished questions', async () => {
    const { svc, prisma } = setup();
    await svc.listAll();
    expect(prisma.faq.findMany.mock.calls[0][0]).not.toHaveProperty('where');
  });

  it('creates with defaults: published, order 0, empty category stored as none', async () => {
    const { svc, prisma } = setup();
    await svc.create({ question: 'How do I pay?', answer: 'Mobile money or card.', category: '' });
    expect(prisma.faq.create.mock.calls[0][0].data).toEqual({
      question: 'How do I pay?',
      answer: 'Mobile money or card.',
      category: null,
      sortOrder: 0,
      isPublished: true,
    });
  });

  it('updates only the fields sent; can unpublish or clear the category', async () => {
    const { svc, prisma } = setup();
    await svc.update('f1', { isPublished: false, category: '' });
    expect(prisma.faq.update.mock.calls[0][0]).toEqual({ where: { id: 'f1' }, data: { isPublished: false, category: null } });
  });

  it('refuses an empty edit, and 404s on unknown ids', async () => {
    const { svc, prisma } = setup();
    await expect(svc.update('f1', {})).rejects.toBeInstanceOf(BadRequestException);
    prisma.faq.update.mockRejectedValueOnce(known('P2025'));
    await expect(svc.update('nope', { answer: 'x y' })).rejects.toBeInstanceOf(NotFoundException);
    prisma.faq.delete.mockRejectedValueOnce(known('P2025'));
    await expect(svc.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('f1')).resolves.toEqual({ deleted: true });
  });
});

describe('FAQ input validation', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown, metatype: any = CreateFaqDto) =>
    pipe.transform(body, { type: 'body', metatype });

  it('trims text and accepts a full question', async () => {
    const out: any = await check({ question: '  How do I pay?  ', answer: ' Mobile money. ', sortOrder: 2 });
    expect(out).toMatchObject({ question: 'How do I pay?', answer: 'Mobile money.', sortOrder: 2 });
  });

  it.each([
    [{ question: 'Hi', answer: 'Mobile money.' }],
    [{ question: 'How do I pay?', answer: '' }],
    [{ question: 'How do I pay?', answer: 'Mobile money.', sortOrder: -1 }],
    [{ question: 'How do I pay?', answer: 'Mobile money.', isPublished: 'yes' }],
    [{ question: 'How do I pay?', answer: 'Mobile money.', extra: 1 }],
  ])('rejects %p', async (body) => {
    await expect(check(body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a partial update', async () => {
    await expect(check({ isPublished: false }, UpdateFaqDto)).resolves.toMatchObject({ isPublished: false });
  });
});

describe('FAQ routes', () => {
  it('the public list needs no login', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, FaqController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, FaqController.prototype.list)).toBeUndefined();
  });

  it('every admin route is ADMIN only', () => {
    expect(new Reflector().get(ROLES_KEY, AdminFaqController)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminFaqController)).toContain(RolesGuard);
  });
});
