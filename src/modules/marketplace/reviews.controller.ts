import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { ReviewsService } from './reviews.service';
import { ListReviewsQueryDto, UpsertReviewDto } from './dto/review.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { assertCustomer } from '../../shared/utils/assert-customer';

type AuthUser = { userId: string; role: string };

@Controller('marketplace')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  // Public, like the product itself.
  @Get('products/:id/reviews')
  list(@Param('id') productId: string, @Query() query: ListReviewsQueryDto) {
    return this.reviews.list(productId, query);
  }

  @UseGuards(JwtAuthGuard)
  @Get('products/:id/reviews/me')
  findMine(@Param('id') productId: string, @CurrentUser() user: AuthUser) {
    assertCustomer(user);
    return this.reviews.findMine(productId, user.userId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('products/:id/reviews')
  upsert(
    @Param('id') productId: string,
    @Body() dto: UpsertReviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertCustomer(user);
    return this.reviews.upsert(productId, user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('products/:id/reviews/me')
  removeMine(@Param('id') productId: string, @CurrentUser() user: AuthUser) {
    assertCustomer(user);
    return this.reviews.removeMine(productId, user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Delete('reviews/:reviewId')
  removeById(@Param('reviewId') reviewId: string) {
    return this.reviews.removeById(reviewId);
  }
}
