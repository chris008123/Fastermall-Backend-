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

import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
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
  @Roles(StaffRole.ADMIN, StaffRole.VENDOR)
  @Post('vendors')
  createVendor(
    @Body() dto: CreateVendorDto,
  ) {
    return this.foodService.createVendor(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN, StaffRole.VENDOR)
  @Post('menu-items')
  createMenuItem(
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.foodService.createMenuItem(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN, StaffRole.VENDOR)
  @Patch('menu-items/:id')
  updateMenuItem(
    @Param('id') id: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.foodService.updateMenuItem(id, dto);
  }
}
