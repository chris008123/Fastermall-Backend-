import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import type { Response } from 'express';
import { DeliveryListQueryDto } from './dto/delivery-list-query.dto';
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
  // `no-cache` = "ask me every time, but answer 304 if nothing changed". The
  // server adds an ETag automatically, so an unchanged list costs almost no
  // data on the 30-second refresh.
  @Header('Cache-Control', 'private, no-cache')
  @Get('deliveries/unassigned')
  findUnassigned(
    @CurrentUser() user: { userId: string; role: string },
    @Query() query: DeliveryListQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('X-Server-Time', new Date().toISOString());
    return this.logisticsService.findUnassigned(user.role, query);
  }

  /**
   * One delivery with its stage history. Must stay below the fixed
   * 'deliveries/unassigned' route above.
   */
  @Get('deliveries/:id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: string },
  ) {
    return this.logisticsService.findOne(id, user.userId, user.role);
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
  // X-Server-Time is taken BEFORE the query, so a job that changes while the
  // query runs is picked up by the next `updatedSince` poll instead of lost.
  @Header('Cache-Control', 'private, no-cache')
  @Get('me/deliveries')
  myDeliveries(
    @CurrentUser() user: { userId: string },
    @Query() query: DeliveryListQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('X-Server-Time', new Date().toISOString());
    return this.logisticsService.myDeliveries(user.userId, query);
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
