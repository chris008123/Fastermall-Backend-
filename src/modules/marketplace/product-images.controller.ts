import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { StaffRole } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';
import { ProductImagesService, UploadedImage } from './product-images.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';

// Multer stops oversized uploads while they stream in (413), before the
// service checks them again. Read once at start-up, like the service.
const MAX_BYTES = parseInt(process.env.PRODUCT_IMAGE_MAX_BYTES || String(5 * 1024 * 1024), 10);
const MAX_FILES = parseInt(process.env.PRODUCT_IMAGES_MAX || '5', 10);

export class ReorderImagesDto {
  // Every image id of the product, in the new order. The first is the main image.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  imageIds!: string[];
}

@Controller('marketplace/products/:id/images')
export class ProductImagesController {
  constructor(private readonly images: ProductImagesService) {}

  // Public, like the product itself.
  @Get()
  list(@Param('id') id: string) {
    return this.images.list(id);
  }

  /**
   * multipart/form-data with one or more files in the "images" field
   * (JPEG, PNG or WebP). They are added after the existing photos.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Post()
  @UseInterceptors(
    FilesInterceptor('images', MAX_FILES, { limits: { fileSize: MAX_BYTES, files: MAX_FILES } }),
  )
  upload(@Param('id') id: string, @UploadedFiles() files: UploadedImage[]) {
    return this.images.add(id, files ?? []);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Patch('order')
  reorder(@Param('id') id: string, @Body() dto: ReorderImagesDto) {
    return this.images.reorder(id, dto.imageIds);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Delete(':imageId')
  remove(@Param('id') id: string, @Param('imageId') imageId: string) {
    return this.images.remove(id, imageId);
  }
}
