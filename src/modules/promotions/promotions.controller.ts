import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { PromotionsService } from './promotions.service';
import { AdminPromotionQueryDto, CreatePromotionDto, PromotionEventDto, UpdatePromotionDto } from './dto/promotion.dto';
import { animationCatalogue } from './animations';
import { UploadedImage } from '../marketplace/product-images.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

const MAX_BYTES = parseInt(process.env.PRODUCT_IMAGE_MAX_BYTES || String(5 * 1024 * 1024), 10);
// Multer stops reading here; the service gives the friendly size error below it.
const LOTTIE_MAX_BYTES = parseInt(process.env.PROMOTION_LOTTIE_MAX_BYTES || String(512 * 1024), 10);

// Public: the app asks on start-up, before or after sign-in.
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  // Short cache: a new promotion shows up within a minute.
  @Header('Cache-Control', 'public, max-age=60')
  @Get('active')
  active() {
    return this.promotions.listActive();
  }

  // The animation presets the app and console can use, with their fallbacks,
  // limits and the rules for older apps, reduce motion and slow phones.
  @Header('Cache-Control', 'public, max-age=300')
  @Get('animations')
  animations() {
    return animationCatalogue();
  }

  // The app reports a popup being seen, its button tapped, or it being
  // closed: { type: VIEW | CLICK | DISMISS }. No login needed. Never fails for
  // an ended or unknown promotion ({ recorded: false }).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':id/events')
  event(@Param('id') id: string, @Body() dto: PromotionEventDto) {
    return this.promotions.recordEvent(id, dto.type);
  }
}

// Admin console. Writes are recorded by the audit log automatically.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.ADMIN)
@Controller('admin/promotions')
export class AdminPromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  // ?status=live|scheduled|ended|inactive
  @Get()
  list(@Query() q: AdminPromotionQueryDto) {
    return this.promotions.listAll(q.status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.promotions.findOne(id);
  }

  // What the app will get for this promotion, even before it is live.
  @Get(':id/preview')
  preview(@Param('id') id: string) {
    return this.promotions.preview(id);
  }

  @Post()
  create(@Body() dto: CreatePromotionDto, @CurrentUser() user: { userId: string }) {
    return this.promotions.create(dto, user.userId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotions.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.promotions.remove(id);
  }

  // multipart/form-data, one file in the "image" field. Replaces the old one.
  @Post(':id/image')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  setImage(@Param('id') id: string, @UploadedFile() file: UploadedImage) {
    return this.promotions.setImage(id, file);
  }

  // multipart/form-data, the Lottie JSON file in the "animation" field.
  // Replaces the old one.
  @Post(':id/animation')
  @UseInterceptors(FileInterceptor('animation', { limits: { fileSize: LOTTIE_MAX_BYTES + 1, files: 1 } }))
  setAnimation(@Param('id') id: string, @UploadedFile() file: UploadedImage) {
    return this.promotions.setLottie(id, file);
  }

  @Delete(':id/animation')
  removeAnimation(@Param('id') id: string) {
    return this.promotions.removeLottie(id);
  }

  // Push it to every customer now (live promotions only, once per 12 hours).
  @Post(':id/announce')
  announce(@Param('id') id: string) {
    return this.promotions.announce(id);
  }
}
