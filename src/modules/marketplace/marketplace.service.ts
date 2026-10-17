import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma: PrismaService) {}

  createCategory(dto: CreateCategoryDto) {
    return this.prisma.category.create({
      data: dto,
    });
  }

  findAllCategories() {
    return this.prisma.category.findMany({
      orderBy: {
        name: 'asc',
      },
    });
  }

  createProduct(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: dto,
    });
  }

  async findAllProducts(params: {
    query?: string;
    categoryId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(params.page ?? 1, 1);
    const pageSize = Math.min(
      Math.max(params.pageSize ?? 20, 1),
      100,
    );

    const query = params.query?.trim();

    const where = {
      ...(params.categoryId
        ? {
            categoryId: params.categoryId,
          }
        : {}),
      ...(query
        ? {
            OR: [
              {
                name: {
                  contains: query,
                  mode: 'insensitive' as const,
                },
              },
              {
                description: {
                  contains: query,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          category: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),

      this.prisma.product.count({
        where,
      }),
    ]);

    return {
      data: products,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      total,
    };
  }

  async findOneProduct(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { category: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async updateProduct(id: string, dto: UpdateProductDto) {
    await this.findOneProduct(id);

    return this.prisma.product.update({
      where: { id },
      data: dto,
    });
  }

  async deleteProduct(id: string) {
    await this.findOneProduct(id);

    await this.prisma.product.delete({
      where: { id },
    });

    return { deleted: true };
  }

  async getProductsByIds(ids: string[]) {
    return this.prisma.product.findMany({
      where: {
        id: {
          in: ids,
        },
      },
    });
  }

  /**
   * Takes stock for every line or for none. Each line only succeeds if enough
   * is left at the moment of the update, so two orders racing for the last
   * unit can't both win and stock can't go negative.
   */
  async reserveStock(items: { productId: string; quantity: number }[]) {
    await this.prisma.$transaction(async (tx) => {
      for (const { productId, quantity } of items) {
        const taken = await tx.product.updateMany({
          where: { id: productId, stock: { gte: quantity } },
          data: { stock: { decrement: quantity } },
        });
        if (taken.count !== 1) {
          throw new BadRequestException('Insufficient stock for one or more items');
        }
      }
    });
  }

  async releaseStock(items: { productId: string; quantity: number }[]) {
    await this.prisma.$transaction(
      items.map(({ productId, quantity }) =>
        this.prisma.product.update({
          where: { id: productId },
          data: { stock: { increment: quantity } },
        }),
      ),
    );
  }
}
