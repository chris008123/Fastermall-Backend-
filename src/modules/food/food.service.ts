import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';

@Injectable()
export class FoodService {
  constructor(private readonly prisma: PrismaService) {}

  createVendor(dto: CreateVendorDto) {
    return this.prisma.foodVendor.create({ data: dto });
  }

  findAllVendors() {
    return this.prisma.foodVendor.findMany({ where: { isActive: true } });
  }

  async findOneVendor(id: string) {
    const vendor = await this.prisma.foodVendor.findUnique({
      where: { id },
      include: { menuItems: true },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  createMenuItem(dto: CreateMenuItemDto) {
    return this.prisma.menuItem.create({ data: dto });
  }

  async updateMenuItem(id: string, dto: UpdateMenuItemDto) {
    const item = await this.prisma.menuItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Menu item not found');
    return this.prisma.menuItem.update({ where: { id }, data: dto });
  }

  findMenuItemsByVendor(vendorId: string) {
    return this.prisma.menuItem.findMany({ where: { vendorId, isAvailable: true } });
  }

  // Used by OrdersService to validate + price food items at order time
  async getMenuItemsByIds(ids: string[]) {
    return this.prisma.menuItem.findMany({ where: { id: { in: ids } } });
  }
}
