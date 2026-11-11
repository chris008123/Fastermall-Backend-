import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LaundryVendorStatus, Prisma, StaffRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  CreateLaundryServiceDto,
  CreateLaundryVendorDto,
  LaundryVendorStatusDto,
  UpdateLaundryServiceDto,
  UpdateLaundryVendorDto,
  UpsertLaundryReviewDto,
} from './dto/laundry-vendor.dto';

// What customers see of a vendor (no commission).
const PUBLIC_VENDOR_SELECT = {
  id: true,
  name: true,
  description: true,
  logoUrl: true,
  location: true,
  phone: true,
  isOpen: true,
  rating: true,
  reviewCount: true,
} satisfies Prisma.LaundryVendorSelect;

const REVIEW_AUTHOR = { user: { select: { fullName: true, deletedAt: true } } } as const;

// Public reviews show the author's first name only.
function toPublicReview(r: { id: string; rating: number; comment: string | null; createdAt: Date; updatedAt: Date; user: { fullName: string; deletedAt: Date | null } }) {
  return {
    id: r.id,
    rating: r.rating,
    comment: r.comment,
    author: r.user.deletedAt ? 'Deleted user' : r.user.fullName.trim().split(/\s+/)[0] || 'Customer',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Laundry vendors (requirement 2.15): discovery, star ratings and reviews for
 * customers; onboarding, approval, catalog and staff for admins. Fastermall
 * still runs every pickup and delivery.
 */
@Injectable()
export class LaundryVendorsService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────── Customers ─────────

  /** Approved vendors: open first, then best rated, then by name. */
  listApproved() {
    return this.prisma.laundryVendor.findMany({
      where: { status: LaundryVendorStatus.APPROVED },
      orderBy: [{ isOpen: 'desc' }, { rating: { sort: 'desc', nulls: 'last' } }, { reviewCount: 'desc' }, { name: 'asc' }],
      select: PUBLIC_VENDOR_SELECT,
    });
  }

  /** One approved vendor with its active services. */
  async getApproved(id: string) {
    const vendor = await this.prisma.laundryVendor.findFirst({
      where: { id, status: LaundryVendorStatus.APPROVED },
      select: {
        ...PUBLIC_VENDOR_SELECT,
        catalogItems: { where: { isActive: true }, orderBy: { name: 'asc' } },
      },
    });
    if (!vendor) throw new NotFoundException('Laundry vendor not found');
    return vendor;
  }

  async listReviews(vendorId: string, page = 1, pageSize = 20) {
    await this.getApproved(vendorId);
    const size = Math.min(Math.max(pageSize, 1), 50);
    const p = Math.max(page, 1);
    const [rows, total] = await Promise.all([
      this.prisma.laundryVendorReview.findMany({
        where: { vendorId },
        include: REVIEW_AUTHOR,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (p - 1) * size,
        take: size,
      }),
      this.prisma.laundryVendorReview.count({ where: { vendorId } }),
    ]);
    return { data: rows.map(toPublicReview), page: p, pageSize: size, hasMore: p * size < total, total };
  }

  /**
   * One review per customer per vendor; writing again edits it. Only after a
   * COMPLETED laundry order with that vendor. Updates the vendor's rating.
   */
  async upsertReview(vendorId: string, userId: string, dto: UpsertLaundryReviewDto) {
    await this.getApproved(vendorId);
    const completed = await this.prisma.laundryOrder.findFirst({
      where: { customerId: userId, vendorId, status: 'COMPLETED' },
      select: { id: true },
    });
    if (!completed) {
      throw new ForbiddenException({
        message: 'You can review a laundry vendor after they complete an order for you',
        code: 'REVIEW_NOT_ALLOWED',
      });
    }
    const comment = dto.comment?.trim() || null;
    const review = await this.prisma.laundryVendorReview.upsert({
      where: { vendorId_userId: { vendorId, userId } },
      create: { vendorId, userId, rating: dto.rating, comment },
      update: { rating: dto.rating, comment },
      include: REVIEW_AUTHOR,
    });
    const vendor = await this.recalculate(vendorId);
    return { review: toPublicReview(review), vendor };
  }

  async removeMyReview(vendorId: string, userId: string) {
    const removed = await this.prisma.laundryVendorReview.deleteMany({ where: { vendorId, userId } });
    if (removed.count === 0) throw new NotFoundException('Review not found');
    return { deleted: true, vendor: await this.recalculate(vendorId) };
  }

  // ───────── Admin ─────────

  adminList(status?: string) {
    return this.prisma.laundryVendor.findMany({
      where: status ? { status: status as LaundryVendorStatus } : {},
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { catalogItems: true, orders: true, staff: true } } },
    });
  }

  async adminGet(id: string) {
    const vendor = await this.prisma.laundryVendor.findUnique({
      where: { id },
      include: {
        catalogItems: { orderBy: { name: 'asc' } },
        staff: { select: { id: true, fullName: true, email: true, phone: true, isActive: true } },
        _count: { select: { orders: true, reviews: true } },
      },
    });
    if (!vendor) throw new NotFoundException('Laundry vendor not found');
    return vendor;
  }

  async create(dto: CreateLaundryVendorDto) {
    this.assertHttps(dto.logoUrl);
    return this.prisma.laundryVendor.create({
      data: {
        name: dto.name,
        description: dto.description || null,
        logoUrl: dto.logoUrl || null,
        location: dto.location || null,
        phone: dto.phone || null,
        isOpen: dto.isOpen ?? true,
        commissionRate: dto.commissionRate ?? null,
        status: dto.status ?? LaundryVendorStatus.PENDING,
      },
    });
  }

  async update(id: string, dto: UpdateLaundryVendorDto) {
    const { status, ...rest } = dto;
    if (status !== undefined) throw new BadRequestException('Change the status with PATCH /admin/laundry/vendors/:id/status');
    if (Object.keys(rest).length === 0) throw new BadRequestException('Nothing to update');
    this.assertHttps(rest.logoUrl);
    try {
      return await this.prisma.laundryVendor.update({ where: { id }, data: rest });
    } catch (e) {
      throw this.notFound(e, 'Laundry vendor not found');
    }
  }

  /** Approve, suspend (hidden from customers, no new orders) or back to pending. */
  async setStatus(id: string, dto: LaundryVendorStatusDto) {
    try {
      return await this.prisma.laundryVendor.update({ where: { id }, data: { status: dto.status } });
    } catch (e) {
      throw this.notFound(e, 'Laundry vendor not found');
    }
  }

  async addService(vendorId: string, dto: CreateLaundryServiceDto) {
    const vendor = await this.prisma.laundryVendor.findUnique({ where: { id: vendorId }, select: { id: true } });
    if (!vendor) throw new NotFoundException('Laundry vendor not found');
    return this.prisma.laundryCatalogItem.create({
      data: { vendorId, name: dto.name, description: dto.description || null, unitPrice: dto.unitPrice, isActive: dto.isActive ?? true },
    });
  }

  /** Edit or switch off a service. Past orders keep their own copy of the price. */
  async updateService(itemId: string, dto: UpdateLaundryServiceDto) {
    if (Object.keys(dto).length === 0) throw new BadRequestException('Nothing to update');
    try {
      return await this.prisma.laundryCatalogItem.update({ where: { id: itemId }, data: dto });
    } catch (e) {
      throw this.notFound(e, 'Laundry service not found');
    }
  }

  /** Puts a LAUNDRY_STAFF account on a vendor (null = Fastermall Laundry). */
  async assignStaff(staffId: string, vendorId: string | null) {
    const staff = await this.prisma.staffUser.findUnique({ where: { id: staffId }, select: { role: true } });
    if (!staff) throw new NotFoundException('Staff account not found');
    if (staff.role !== StaffRole.LAUNDRY_STAFF) {
      throw new BadRequestException('Only LAUNDRY_STAFF accounts work for a laundry vendor');
    }
    if (vendorId) {
      const vendor = await this.prisma.laundryVendor.findUnique({ where: { id: vendorId }, select: { id: true } });
      if (!vendor) throw new NotFoundException('Laundry vendor not found');
    }
    return this.prisma.staffUser.update({
      where: { id: staffId },
      data: { laundryVendorId: vendorId },
      select: { id: true, fullName: true, role: true, laundryVendorId: true },
    });
  }

  /** Moderation: removes any review and updates the vendor's rating. */
  async adminRemoveReview(reviewId: string) {
    const review = await this.prisma.laundryVendorReview.findUnique({ where: { id: reviewId }, select: { vendorId: true } });
    if (!review) throw new NotFoundException('Review not found');
    await this.prisma.laundryVendorReview.delete({ where: { id: reviewId } });
    return { deleted: true, vendor: await this.recalculate(review.vendorId) };
  }

  // ───────── Internals ─────────

  // Average (one decimal, null without reviews) and count, stored on the vendor.
  private async recalculate(vendorId: string) {
    const agg = await this.prisma.laundryVendorReview.aggregate({
      where: { vendorId },
      _avg: { rating: true },
      _count: { _all: true },
    });
    const rating = agg._avg.rating === null ? null : Math.round(agg._avg.rating * 10) / 10;
    return this.prisma.laundryVendor.update({
      where: { id: vendorId },
      data: { rating, reviewCount: agg._count._all },
      select: { id: true, rating: true, reviewCount: true },
    });
  }

  private assertHttps(url?: string | null) {
    if (url && !/^https:\/\/\S+$/i.test(url)) {
      throw new BadRequestException({ message: 'logoUrl must be an https link', code: 'INVALID_IMAGE_URL' });
    }
  }

  private notFound(e: unknown, message: string) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return new NotFoundException(message);
    return e;
  }
}
