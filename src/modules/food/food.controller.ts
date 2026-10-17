import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { StaffRole } from '@prisma/client';

import { FoodService } from './food.service';

import { CreateVendorDto } from './dto/create-vendor.dto';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { AssignVendorOwnerDto } from './dto/assign-vendor-owner.dto';

import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
@Controller('food')
export class FoodController {
  constructor(
    private readonly foodService: FoodService,
  ) {}

  // ============================================================
  // PUBLIC FOOD CATALOG
  // ============================================================

  @Get('categories')
  findAllCategories() {
    return this.foodService.findAllCategories();
  }

  @Get('vendors')
  findAllVendors(
    @Query('categoryId') categoryId?: string,
    @Query('query') query?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.foodService.findAllVendors({
      categoryId,
      query,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('vendors/:id')
  findOneVendor(
    @Param('id') id: string,
  ) {
    return this.foodService.findOneVendor(id);
  }

  @Get('vendors/:id/menu')
  findMenu(
    @Param('id') id: string,
  ) {
    return this.foodService.findMenuItemsByVendor(id);
  }

  @Get('menu-items/:id')
  findOneMenuItem(
    @Param('id') id: string,
  ) {
    return this.foodService.findOneMenuItem(id);
  }

  // ============================================================
  // ADMIN / VENDOR MANAGEMENT
  // ============================================================

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Post('vendors')
  createVendor(
    @Body() dto: CreateVendorDto,
  ) {
    return this.foodService.createVendor(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Patch('vendors/:id/owner')
  assignVendorOwner(
    @Param('id') id: string,
    @Body() dto: AssignVendorOwnerDto,
  ) {
    return this.foodService.assignVendorOwner(id, dto.ownerStaffId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN, StaffRole.VENDOR)
  @Post('menu-items')
  createMenuItem(
    @CurrentUser() user: { userId: string; role: string },
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.foodService.createMenuItem(user, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN, StaffRole.VENDOR)
  @Patch('menu-items/:id')
  updateMenuItem(
    @CurrentUser() user: { userId: string; role: string },
    @Param('id') id: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.foodService.updateMenuItem(user, id, dto);
  }
}
