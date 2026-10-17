import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { StaffRole } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';

import { CreateVendorDto } from './dto/create-vendor.dto';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';

export type StaffActor = { userId: string; role: string };

@Injectable()
export class FoodService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // CATEGORIES
  // ============================================================

  async findAllCategories() {
    return this.prisma.foodCategory.findMany({
      orderBy: {
        name: 'asc',
      },
    });
  }

  // ============================================================
  // VENDORS
  // ============================================================

  async findAllVendors(params?: {
    categoryId?: string;
    query?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(params?.page ?? 1, 1);
    const pageSize = Math.min(
      Math.max(params?.pageSize ?? 6, 1),
      100,
    );

    const query = params?.query?.trim();

    const where = {
      isActive: true,

      ...(params?.categoryId
        ? {
            categoryIds: {
              has: params.categoryId,
            },
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
              {
                location: {
                  contains: query,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };

    const [vendors, total] = await Promise.all([
      this.prisma.foodVendor.findMany({
        where,
        orderBy: [
          {
            isOpen: 'desc',
          },
          {
            rating: 'desc',
          },
          {
            name: 'asc',
          },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),

      this.prisma.foodVendor.count({
        where,
      }),
    ]);

    return {
      data: vendors,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      total,
    };
  }

  async findOneVendor(id: string) {
    const vendor = await this.prisma.foodVendor.findUnique({
      where: { id },
      include: {
        menuItems: {
          where: {
            isAvailable: true,
          },
          orderBy: {
            name: 'asc',
          },
        },
      },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    return vendor;
  }

  // ============================================================
  // MENU ITEMS
  // ============================================================

  async findMenuItemsByVendor(vendorId: string) {
    const vendor = await this.prisma.foodVendor.findUnique({
      where: {
        id: vendorId,
      },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    return this.prisma.menuItem.findMany({
      where: {
        vendorId,
        isAvailable: true,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findOneMenuItem(id: string) {
    const item = await this.prisma.menuItem.findUnique({
      where: {
        id,
      },
      include: {
        vendor: true,
      },
    });

    if (!item) {
      throw new NotFoundException('Menu item not found');
    }

    return item;
  }

  // ============================================================
  // ADMIN / VENDOR MANAGEMENT
  // ============================================================

  // ADMIN may manage every vendor. A VENDOR may only manage vendors they own.
  private async assertCanManageVendor(actor: StaffActor, vendorId: string) {
    const vendor = await this.prisma.foodVendor.findUnique({
      where: { id: vendorId },
      select: { id: true, ownerStaffId: true },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    if (actor.role === StaffRole.ADMIN) return;

    if (actor.role !== StaffRole.VENDOR || vendor.ownerStaffId !== actor.userId) {
      throw new ForbiddenException('You do not manage this vendor');
    }
  }

  private async assertIsVendorStaff(staffId: string) {
    const staff = await this.prisma.staffUser.findUnique({
      where: { id: staffId },
      select: { role: true },
    });

    if (!staff || staff.role !== StaffRole.VENDOR) {
      throw new BadRequestException('Owner must be an existing VENDOR staff account');
    }
  }

  async createVendor(dto: CreateVendorDto) {
    if (dto.ownerStaffId) {
      await this.assertIsVendorStaff(dto.ownerStaffId);
    }

    return this.prisma.foodVendor.create({
      data: dto,
    });
  }

  async assignVendorOwner(vendorId: string, ownerStaffId: string) {
    await this.findOneVendor(vendorId);
    await this.assertIsVendorStaff(ownerStaffId);

    return this.prisma.foodVendor.update({
      where: { id: vendorId },
      data: { ownerStaffId },
    });
  }

  async createMenuItem(actor: StaffActor, dto: CreateMenuItemDto) {
    await this.assertCanManageVendor(actor, dto.vendorId);

    return this.prisma.menuItem.create({
      data: dto,
    });
  }

  async updateMenuItem(
    actor: StaffActor,
    id: string,
    dto: UpdateMenuItemDto,
  ) {
    const item = await this.prisma.menuItem.findUnique({
      where: { id },
      select: { vendorId: true },
    });

    if (!item) {
      throw new NotFoundException('Menu item not found');
    }

    await this.assertCanManageVendor(actor, item.vendorId);

    return this.prisma.menuItem.update({
      where: { id },
      data: dto,
    });
  }

  // ============================================================
  // ORDER SUPPORT
  // ============================================================

  async getMenuItemsByIds(ids: string[]) {
    return this.prisma.menuItem.findMany({
      where: {
        id: {
          in: ids,
        },
      },
    });
  }
}
