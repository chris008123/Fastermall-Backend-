import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReviewsService } from './reviews.service';
import { UpsertReviewDto } from './dto/review.dto';

const now = new Date('2026-11-02T12:00:00Z');
const stored = (over: object = {}) => ({
  id: 'r1', productId: 'p1', userId: 'u1', rating: 4, comment: 'Good', createdAt: now, updatedAt: now,
  user: { fullName: 'Ama Mensah', deletedAt: null }, ...over,
});

function setup() {
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    productReview: {
      upsert: jest.fn().mockResolvedValue(stored()),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      aggregate: jest.fn().mockResolvedValue({ _avg: { rating: 4.333333 }, _count: { _all: 3 } }),
    },
    product: { update: jest.fn() },
  };
  const prisma: any = {
    product: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }) },
    orderItem: { findFirst: jest.fn().mockResolvedValue({ id: 'oi1' }) },
    productReview: {
      findMany: jest.fn().mockResolvedValue([stored()]),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  return { svc: new ReviewsService(prisma), prisma, tx };
}

describe('ReviewsService', () => {
  it('validates the rating as a whole number from 1 to 5', () => {
    const errors = (body: object) => validateSync(plainToInstance(UpsertReviewDto, body));
    expect(errors({ rating: 5 })).toHaveLength(0);
    expect(errors({ rating: 0 })).not.toHaveLength(0);
    expect(errors({ rating: 6 })).not.toHaveLength(0);
    expect(errors({ rating: 4.5 })).not.toHaveLength(0);
  });

  describe('writing a review', () => {
    it('only allows customers with a delivered marketplace order of the product', async () => {
      const { svc, prisma } = setup();
      prisma.orderItem.findFirst.mockResolvedValue(null);
      await expect(svc.upsert('p1', 'u1', { rating: 5 })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.orderItem.findFirst.mock.calls[0][0].where).toEqual({
        productId: 'p1',
        order: { customerId: 'u1', type: 'MARKETPLACE', status: 'DELIVERED' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates or replaces the one review and refreshes the product rating', async () => {
      const { svc, tx } = setup();
      const result = await svc.upsert('p1', 'u1', { rating: 4, comment: '  Good  ' });

      expect(tx.$queryRaw).toHaveBeenCalled(); // product row lock
      expect(tx.productReview.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { productId_userId: { productId: 'p1', userId: 'u1' } },
        create: { productId: 'p1', userId: 'u1', rating: 4, comment: 'Good' },
        update: { rating: 4, comment: 'Good' },
      }));
      expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { rating: 4.3, reviewCount: 3 } });
      expect(result.product).toEqual({ id: 'p1', rating: 4.3, reviewCount: 3 });
    });

    it('shows only the author’s first name', async () => {
      const { svc } = setup();
      const { review } = await svc.upsert('p1', 'u1', { rating: 4 });
      expect(review.author).toBe('Ama');
      expect(review).not.toHaveProperty('userId');
    });

    it('404s for an unknown product', async () => {
      const { svc, prisma } = setup();
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(svc.upsert('nope', 'u1', { rating: 4 })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removing a review', () => {
    it('sets rating back to null when the last review goes', async () => {
      const { svc, tx } = setup();
      tx.productReview.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } });
      await expect(svc.removeMine('p1', 'u1')).resolves.toEqual({
        deleted: true,
        product: { id: 'p1', rating: null, reviewCount: 0 },
      });
      expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { rating: null, reviewCount: 0 } });
    });

    it('404s when the customer has no review', async () => {
      const { svc, tx } = setup();
      tx.productReview.deleteMany.mockResolvedValue({ count: 0 });
      await expect(svc.removeMine('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.product.update).not.toHaveBeenCalled();
    });
  });

  describe('listing', () => {
    it('pages newest first and names a deleted author "Deleted user"', async () => {
      const { svc, prisma } = setup();
      prisma.productReview.findMany.mockResolvedValue([
        stored({ user: { fullName: 'Deleted user', deletedAt: now } }),
      ]);
      const result = await svc.list('p1', { page: 2, pageSize: 100 });
      const args = prisma.productReview.findMany.mock.calls[0][0];
      expect(args).toMatchObject({ where: { productId: 'p1' }, skip: 50, take: 50 });
      expect(result.data[0].author).toBe('Deleted user');
      expect(result).toMatchObject({ page: 2, pageSize: 50, total: 1, hasMore: false });
    });
  });
});
