import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma: PrismaService) {}

  createCategory(dto: CreateCategoryDto) {
    return this.prisma.category.create({ data: dto });
  }

  findAllCategories() {
    return this.prisma.category.findMany();
  }

  createProduct(dto: CreateProductDto) {
    return this.prisma.product.create({ data: dto });
  }

  findAllProducts(categoryId?: string) {
    return this.prisma.product.findMany({
      where: categoryId ? { categoryId } : undefined,
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneProduct(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { category: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async updateProduct(id: string, dto: UpdateProductDto) {
    await this.findOneProduct(id);
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  async deleteProduct(id: string) {
    await this.findOneProduct(id);
    await this.prisma.product.delete({ where: { id } });
    return { deleted: true };
  }

  async getProductsByIds(ids: string[]) {
    return this.prisma.product.findMany({ where: { id: { in: ids } } });
  }

  async decrementStock(productId: string, quantity: number) {
    return this.prisma.product.update({
      where: { id: productId },
      data: { stock: { decrement: quantity } },
    });
  }
}
