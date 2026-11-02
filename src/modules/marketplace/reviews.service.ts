import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, OrderType, Prisma, ProductReview } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ListReviewsQueryDto, UpsertReviewDto } from './dto/review.dto';

type ReviewWithAuthor = ProductReview & {
  user: { fullName: string; deletedAt: Date | null };
};

const AUTHOR_SELECT = {
  user: { select: { fullName: true, deletedAt: true } },
} as const;

// Reviews are public, so only the author's first name is shown.
function toPublicReview(review: ReviewWithAuthor) {
  const firstName = review.user.deletedAt
    ? 'Deleted user'
    : review.user.fullName.trim().split(/\s+/)[0] || 'Customer';
  return {
    id: review.id,
    productId: review.productId,
    rating: review.rating,
    comment: review.comment,
    author: firstName,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

/**
 * Product ratings. A customer can review a marketplace product once they
 * have had an order containing it delivered. Each write recalculates the
 * product's stored `rating` (average, null with no reviews) and
 * `reviewCount`, so listings can sort and filter on them cheaply.
 */
@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(productId: string, params: ListReviewsQueryDto) {
    await this.productOrThrow(productId);

    const page = Math.max(params.page ?? 1, 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 50);

    const [reviews, total] = await Promise.all([
      this.prisma.productReview.findMany({
        where: { productId },
        include: AUTHOR_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.productReview.count({ where: { productId } }),
    ]);

    return {
      data: reviews.map(toPublicReview),
      page,
      pageSize,
      hasMore: page * pageSize < total,
      total,
    };
  }

  // The caller's own review of the product, or null.
  async findMine(productId: string, userId: string) {
    await this.productOrThrow(productId);
    const review = await this.prisma.productReview.findUnique({
      where: { productId_userId: { productId, userId } },
      include: AUTHOR_SELECT,
    });
    return review ? toPublicReview(review) : null;
  }

  async upsert(productId: string, userId: string, dto: UpsertReviewDto) {
    await this.productOrThrow(productId);

    const delivered = await this.prisma.orderItem.findFirst({
      where: {
        productId,
        order: {
          customerId: userId,
          type: OrderType.MARKETPLACE,
          status: OrderStatus.DELIVERED,
        },
      },
      select: { id: true },
    });

    if (!delivered) {
      throw new ForbiddenException(
        'You can review a product once an order with it has been delivered',
      );
    }

    const comment = dto.comment?.trim() || null;

    return this.prisma.$transaction(async (tx) => {
      await this.lockProduct(tx, productId);

      const review = await tx.productReview.upsert({
        where: { productId_userId: { productId, userId } },
        create: { productId, userId, rating: dto.rating, comment },
        update: { rating: dto.rating, comment },
        include: AUTHOR_SELECT,
      });

      const product = await this.refreshSummary(tx, productId);
      return { review: toPublicReview(review), product };
    });
  }

  async removeMine(productId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockProduct(tx, productId);

      const removed = await tx.productReview.deleteMany({
        where: { productId, userId },
      });
      if (removed.count === 0) {
        throw new NotFoundException('Review not found');
      }

      const product = await this.refreshSummary(tx, productId);
      return { deleted: true, product };
    });
  }

  // Admin moderation.
  async removeById(reviewId: string) {
    const review = await this.prisma.productReview.findUnique({
      where: { id: reviewId },
      select: { productId: true },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockProduct(tx, review.productId);
      await tx.productReview.deleteMany({ where: { id: reviewId } });
      const product = await this.refreshSummary(tx, review.productId);
      return { deleted: true, product };
    });
  }

  private async productOrThrow(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
  }

  // Two reviews of the same product written at once would otherwise each
  // calculate the average without the other one.
  private async lockProduct(tx: Prisma.TransactionClient, productId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "products" WHERE id = ${productId} FOR UPDATE`;
    if (!rows?.length) {
      throw new NotFoundException('Product not found');
    }
  }

  private async refreshSummary(tx: Prisma.TransactionClient, productId: string) {
    const stats = await tx.productReview.aggregate({
      where: { productId },
      _avg: { rating: true },
      _count: { _all: true },
    });

    const reviewCount = stats._count._all;
    const rating =
      reviewCount > 0 && stats._avg.rating !== null
        ? Math.round(stats._avg.rating * 10) / 10
        : null;

    await tx.product.update({
      where: { id: productId },
      data: { rating, reviewCount },
    });

    return { id: productId, rating, reviewCount };
  }
}
