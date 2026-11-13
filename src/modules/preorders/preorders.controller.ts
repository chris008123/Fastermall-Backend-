import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { PreOrdersService } from './preorders.service';
import {
  AdminPreOrderQueryDto,
  AdminPreOrderStatusDto,
  CreatePreOrderDto,
  CreateVariantDto,
  CustomerNoteDto,
  QuotePreOrderDto,
  UpdateVariantDto,
} from './dto/preorder.dto';
import { UploadedImage } from '../marketplace/product-images.service';
import { CustomerGuard } from '../../shared/guards/customer.guard';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

type Customer = { userId: string; role?: string };

// The signed-in customer's own pre-orders.
@UseGuards(JwtAuthGuard, CustomerGuard)
@Controller('preorders')
export class PreOrdersController {
  constructor(private readonly preorders: PreOrdersService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: Customer, @Body() dto: CreatePreOrderDto) {
    return this.preorders.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: Customer) {
    return this.preorders.listMine(user.userId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: Customer, @Param('id') id: string) {
    return this.preorders.findMine(user.userId, id);
  }

  // multipart/form-data, field "images" (up to 5 photos, JPEG/PNG/WebP).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/images')
  @UseInterceptors(FilesInterceptor('images', 5, { limits: { fileSize: 5 * 1024 * 1024, files: 5 } }))
  addImages(@CurrentUser() user: Customer, @Param('id') id: string, @UploadedFiles() files: UploadedImage[]) {
    return this.preorders.addImages(user.userId, id, files ?? []);
  }

  @Post(':id/accept')
  accept(@CurrentUser() user: Customer, @Param('id') id: string) {
    return this.preorders.accept(user.userId, id);
  }

  @Post(':id/decline')
  decline(@CurrentUser() user: Customer, @Param('id') id: string, @Body() dto: CustomerNoteDto) {
    return this.preorders.decline(user.userId, id, dto.note);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: Customer, @Param('id') id: string, @Body() dto: CustomerNoteDto) {
    return this.preorders.cancel(user.userId, id, dto.note);
  }
}

// Admin console: requests, quotes, and product designs.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.ADMIN)
@Controller()
export class AdminPreOrdersController {
  constructor(private readonly preorders: PreOrdersService) {}

  @Get('admin/preorders')
  list(@Query() q: AdminPreOrderQueryDto) {
    return this.preorders.adminList(q.status);
  }

  @Get('admin/preorders/:id')
  findOne(@Param('id') id: string) {
    return this.preorders.adminFind(id);
  }

  @Post('admin/preorders/:id/quote')
  quote(@Param('id') id: string, @Body() dto: QuotePreOrderDto) {
    return this.preorders.quote(id, dto);
  }

  @Patch('admin/preorders/:id/status')
  setStatus(@Param('id') id: string, @Body() dto: AdminPreOrderStatusDto) {
    return this.preorders.adminSetStatus(id, dto);
  }

  @Post('marketplace/products/:id/variants')
  createVariant(@Param('id') id: string, @Body() dto: CreateVariantDto) {
    return this.preorders.createVariant(id, dto);
  }

  @Patch('marketplace/variants/:id')
  updateVariant(@Param('id') id: string, @Body() dto: UpdateVariantDto) {
    return this.preorders.updateVariant(id, dto);
  }

  @Delete('marketplace/variants/:id')
  deleteVariant(@Param('id') id: string) {
    return this.preorders.deleteVariant(id);
  }
}
