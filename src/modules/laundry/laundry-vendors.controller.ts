import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { LaundryVendorsService } from './laundry-vendors.service';
import {
  AdminVendorQueryDto,
  AssignLaundryVendorDto,
  CreateLaundryServiceDto,
  CreateLaundryVendorDto,
  LaundryVendorStatusDto,
  ReviewsPageDto,
  UpdateLaundryServiceDto,
  UpdateLaundryVendorDto,
  UpsertLaundryReviewDto,
} from './dto/laundry-vendor.dto';
import { CustomerGuard } from '../../shared/guards/customer.guard';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

// Customers choosing a laundry vendor (signed in, like the rest of /laundry).
@UseGuards(JwtAuthGuard)
@Controller('laundry/vendors')
export class LaundryVendorsController {
  constructor(private readonly vendors: LaundryVendorsService) {}

  @Get()
  list() {
    return this.vendors.listApproved();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.vendors.getApproved(id);
  }

  // Same as GET /laundry/catalog?vendorId=:id.
  @Get(':id/catalog')
  async catalog(@Param('id') id: string) {
    return (await this.vendors.getApproved(id)).catalogItems;
  }

  @Get(':id/reviews')
  reviews(@Param('id') id: string, @Query() q: ReviewsPageDto) {
    return this.vendors.listReviews(id, q.page, q.pageSize);
  }

  @UseGuards(CustomerGuard)
  @Post(':id/reviews')
  review(@Param('id') id: string, @CurrentUser() user: { userId: string }, @Body() dto: UpsertLaundryReviewDto) {
    return this.vendors.upsertReview(id, user.userId, dto);
  }

  @UseGuards(CustomerGuard)
  @Delete(':id/reviews/me')
  removeReview(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.vendors.removeMyReview(id, user.userId);
  }
}

// Admin console: onboarding, approval, catalog, staff and moderation.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.ADMIN)
@Controller('admin/laundry')
export class AdminLaundryVendorsController {
  constructor(private readonly vendors: LaundryVendorsService) {}

  @Get('vendors')
  list(@Query() q: AdminVendorQueryDto) {
    return this.vendors.adminList(q.status);
  }

  @Get('vendors/:id')
  findOne(@Param('id') id: string) {
    return this.vendors.adminGet(id);
  }

  @Post('vendors')
  create(@Body() dto: CreateLaundryVendorDto) {
    return this.vendors.create(dto);
  }

  @Patch('vendors/:id')
  update(@Param('id') id: string, @Body() dto: UpdateLaundryVendorDto) {
    return this.vendors.update(id, dto);
  }

  @Patch('vendors/:id/status')
  setStatus(@Param('id') id: string, @Body() dto: LaundryVendorStatusDto) {
    return this.vendors.setStatus(id, dto);
  }

  @Post('vendors/:id/catalog')
  addService(@Param('id') id: string, @Body() dto: CreateLaundryServiceDto) {
    return this.vendors.addService(id, dto);
  }

  @Patch('catalog/:itemId')
  updateService(@Param('itemId') itemId: string, @Body() dto: UpdateLaundryServiceDto) {
    return this.vendors.updateService(itemId, dto);
  }

  @Patch('staff/:staffId/vendor')
  assignStaff(@Param('staffId') staffId: string, @Body() dto: AssignLaundryVendorDto) {
    return this.vendors.assignStaff(staffId, dto.vendorId ?? null);
  }

  @Delete('reviews/:id')
  removeReview(@Param('id') id: string) {
    return this.vendors.adminRemoveReview(id);
  }
}
