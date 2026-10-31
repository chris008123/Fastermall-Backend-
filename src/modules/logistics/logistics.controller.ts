import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { LogisticsService } from './logistics.service';
import { IdempotencyInterceptor } from '../../shared/interceptors/idempotency.interceptor';

import { UpdatePartnerStatusDto } from './dto/update-partner-status.dto';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto';

import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

import { StaffRole } from '@prisma/client';
import { VerifyDeliveryCodeDto } from './dto/verify-delivery-code.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.DELIVERY_PARTNER, StaffRole.ADMIN)
@Controller('logistics')
export class LogisticsController {
  constructor(
    private readonly logisticsService: LogisticsService,
  ) {}

  /**
   * Get deliveries that have not yet been claimed.
   */
  @Get('deliveries/unassigned')
  findUnassigned(
    @CurrentUser() user: { userId: string; role: string },
  ) {
    return this.logisticsService.findUnassigned(user.role);
  }

  /**
   * Claim a delivery. `accept` is the name the partner app uses; both
   * routes do exactly the same thing.
   */
  @UseInterceptors(IdempotencyInterceptor)
  @Post('deliveries/:id/accept')
  accept(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: string },
  ) {
    return this.logisticsService.claim(id, user.userId, user.role);
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post('deliveries/:id/claim')
  claim(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: string },
  ) {
    return this.logisticsService.claim(
      id,
      user.userId,
      user.role,
    );
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post('deliveries/:id/verify-code')
  verifyDeliveryCode(
    @Param('id') id: string,
    @Body() dto: VerifyDeliveryCodeDto,
    @CurrentUser() user: { userId: string },
  ) {
    return this.logisticsService.verifyDeliveryCode(
      id,
      dto.code,
      user.userId,
    );
  }

  /**
   * Update delivery progress.
   *
   * The logged-in user's ID is passed to the service so
   * the service can verify that the delivery belongs to
   * that delivery partner.
   */
  @UseInterceptors(IdempotencyInterceptor)
  @Patch('deliveries/:id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryStatusDto,
    @CurrentUser() user: { userId: string },
  ) {
    return this.logisticsService.updateStatus(
      id,
      dto,
      user.userId,
    );
  }

  /**
   * The signed-in partner's profile.
   */
  @Get('me')
  me(@CurrentUser() user: { userId: string }) {
    return this.logisticsService.getMyProfile(user.userId);
  }

  /**
   * Update delivery partner availability.
   */
  @Patch('me')
  updateMyStatus(
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdatePartnerStatusDto,
  ) {
    return this.logisticsService.updatePartnerStatus(
      user.userId,
      dto,
    );
  }

  /**
   * Get deliveries assigned to the current partner.
   */
  @Get('me/deliveries')
  myDeliveries(
    @CurrentUser() user: { userId: string },
  ) {
    return this.logisticsService.myDeliveries(
      user.userId,
    );
  }

  /**
   * Get current partner earnings.
   */
  @Get('me/earnings')
  myEarnings(
    @CurrentUser() user: { userId: string },
  ) {
    return this.logisticsService.myEarnings(
      user.userId,
    );
  }
}
