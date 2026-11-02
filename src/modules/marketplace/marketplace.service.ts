import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  ListProductsQueryDto,
  ProductSort,
} from './dto/list-products-query.dto';

// The app shows the vendor's name on every product card.
const PRODUCT_INCLUDE = {
  category: true,
  vendor: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

// Every sort ends with id so pages never overlap or skip products that tie.
function productOrderBy(
  sort: ProductSort | undefined,
): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'price_asc':
      return [{ price: 'asc' }, { id: 'asc' }];
    case 'price_desc':
      return [{ price: 'desc' }, { id: 'asc' }];
    case 'rating':
      // Best rated first; unrated products go last.
      return [
        { rating: { sort: 'desc', nulls: 'last' } },
        { reviewCount: 'desc' },
        { id: 'asc' },
      ];
    case 'popular':
      // Number of order lines that included the product.
      return [{ orderItems: { _count: 'desc' } }, { createdAt: 'desc' }, { id: 'asc' }];
    case 'relevance':
    default:
      return [{ createdAt: 'desc' }, { id: 'asc' }];
  }
}

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

  async findAllProducts(params: ListProductsQueryDto) {
    const page = Math.max(params.page ?? 1, 1);
    const pageSize = Math.min(
      Math.max(params.pageSize ?? 20, 1),
      100,
    );

    const query = params.query?.trim();

    if (
      params.minPrice !== undefined &&
      params.maxPrice !== undefined &&
      params.minPrice > params.maxPrice
    ) {
      throw new BadRequestException(
        'minPrice cannot be greater than maxPrice',
      );
    }

    const price: Prisma.DecimalFilter = {
      ...(params.minPrice !== undefined ? { gte: params.minPrice } : {}),
      ...(params.maxPrice !== undefined ? { lte: params.maxPrice } : {}),
    };

    const where: Prisma.ProductWhereInput = {
      ...(params.categoryId
        ? {
            categoryId: params.categoryId,
          }
        : {}),
      ...(Object.keys(price).length > 0 ? { price } : {}),
      ...(params.inStock ? { stock: { gt: 0 } } : {}),
      ...(params.minRating !== undefined
        ? { rating: { gte: params.minRating } }
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
        include: PRODUCT_INCLUDE,
        orderBy: productOrderBy(params.sort),
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
      include: PRODUCT_INCLUDE,
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

  async decrementStock(productId: string, quantity: number) {
    return this.prisma.product.update({
      where: { id: productId },
      data: {
        stock: {
          decrement: quantity,
        },
      },
    });
  }
}
