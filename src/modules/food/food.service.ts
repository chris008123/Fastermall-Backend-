import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma, StaffRole } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';

import { CreateVendorDto } from './dto/create-vendor.dto';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import {
  CreateOptionDto,
  CreateOptionGroupDto,
  UpdateOptionDto,
  UpdateOptionGroupDto,
} from './dto/menu-options.dto';

// A menu item's choices, in display order. Unavailable options are listed
// (greyed out in the app) so the menu does not jump around.
export const OPTION_GROUPS_INCLUDE = {
  optionGroups: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { options: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
  },
} satisfies Prisma.MenuItemInclude;

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
          include: OPTION_GROUPS_INCLUDE,
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
      include: OPTION_GROUPS_INCLUDE,
    });
  }

  async findOneMenuItem(id: string) {
    const item = await this.prisma.menuItem.findUnique({
      where: {
        id,
      },
      include: {
        vendor: true,
        ...OPTION_GROUPS_INCLUDE,
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
      include: OPTION_GROUPS_INCLUDE,
    });
  }

  // ============================================================
  // CUSTOMISATION (option groups and options)
  // ============================================================

  private async vendorOfMenuItem(menuItemId: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id: menuItemId }, select: { vendorId: true } });
    if (!item) throw new NotFoundException('Menu item not found');
    return item.vendorId;
  }

  private async groupFor(groupId: string) {
    const group = await this.prisma.menuItemOptionGroup.findUnique({
      where: { id: groupId },
      select: { id: true, menuItemId: true, minSelect: true, maxSelect: true, menuItem: { select: { vendorId: true } } },
    });
    if (!group) throw new NotFoundException('Option group not found');
    return group;
  }

  private assertSelectRange(minSelect: number, maxSelect: number) {
    if (minSelect > maxSelect) {
      throw new BadRequestException('minSelect cannot be more than maxSelect');
    }
  }

  async createOptionGroup(actor: StaffActor, menuItemId: string, dto: CreateOptionGroupDto) {
    await this.assertCanManageVendor(actor, await this.vendorOfMenuItem(menuItemId));
    const minSelect = dto.minSelect ?? 0;
    const maxSelect = dto.maxSelect ?? Math.max(1, minSelect);
    this.assertSelectRange(minSelect, maxSelect);
    return this.prisma.menuItemOptionGroup.create({
      data: { menuItemId, name: dto.name, minSelect, maxSelect, sortOrder: dto.sortOrder ?? 0 },
      include: { options: true },
    });
  }

  async updateOptionGroup(actor: StaffActor, groupId: string, dto: UpdateOptionGroupDto) {
    const group = await this.groupFor(groupId);
    await this.assertCanManageVendor(actor, group.menuItem.vendorId);
    this.assertSelectRange(dto.minSelect ?? group.minSelect, dto.maxSelect ?? group.maxSelect);
    if (Object.keys(dto).length === 0) throw new BadRequestException('Nothing to update');
    return this.prisma.menuItemOptionGroup.update({
      where: { id: groupId },
      data: dto,
      include: { options: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
  }

  /** Deletes the group and its options. Past orders keep their snapshot. */
  async deleteOptionGroup(actor: StaffActor, groupId: string) {
    const group = await this.groupFor(groupId);
    await this.assertCanManageVendor(actor, group.menuItem.vendorId);
    await this.prisma.menuItemOptionGroup.delete({ where: { id: groupId } });
    return { deleted: true };
  }

  async createOption(actor: StaffActor, groupId: string, dto: CreateOptionDto) {
    const group = await this.groupFor(groupId);
    await this.assertCanManageVendor(actor, group.menuItem.vendorId);
    return this.prisma.menuItemOption.create({
      data: {
        groupId,
        name: dto.name,
        price: dto.price ?? 0,
        maxQuantity: dto.maxQuantity ?? 1,
        isAvailable: dto.isAvailable ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  private async optionFor(optionId: string) {
    const option = await this.prisma.menuItemOption.findUnique({
      where: { id: optionId },
      select: { id: true, group: { select: { menuItem: { select: { vendorId: true } } } } },
    });
    if (!option) throw new NotFoundException('Option not found');
    return option;
  }

  /** E.g. { isAvailable: false } when the eggs run out. */
  async updateOption(actor: StaffActor, optionId: string, dto: UpdateOptionDto) {
    const option = await this.optionFor(optionId);
    await this.assertCanManageVendor(actor, option.group.menuItem.vendorId);
    if (Object.keys(dto).length === 0) throw new BadRequestException('Nothing to update');
    return this.prisma.menuItemOption.update({ where: { id: optionId }, data: dto });
  }

  async deleteOption(actor: StaffActor, optionId: string) {
    const option = await this.optionFor(optionId);
    await this.assertCanManageVendor(actor, option.group.menuItem.vendorId);
    await this.prisma.menuItemOption.delete({ where: { id: optionId } });
    return { deleted: true };
  }
}
