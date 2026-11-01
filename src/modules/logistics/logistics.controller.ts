import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import type { Response } from 'express';
import { DeliveryListQueryDto } from './dto/delivery-list-query.dto';
import { Throttle } from '@nestjs/throttler';
import { AccountDeletionService } from '../staff/account-deletion.service';
import { ProfileService } from './profile.service';
import { DocumentsService } from './documents.service';
import { PresenceService } from './presence.service';
import { UpdateLocationDto } from './dto/update-location.dto';
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
    private readonly presence: PresenceService,
    private readonly documents: DocumentsService,
    private readonly deletion: AccountDeletionService,
    private readonly profileService: ProfileService,
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
    void this.presence.touch(user.userId); // the app's refresh doubles as a heartbeat
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
  async accept(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: string },
  ) {
    await this.deletion.assertNotLeaving(user.userId);
    await this.documents.assertCanWork(user.userId, user.role);
    return this.logisticsService.claim(id, user.userId, user.role);
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post('deliveries/:id/claim')
  async claim(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: string },
  ) {
    await this.deletion.assertNotLeaving(user.userId);
    await this.documents.assertCanWork(user.userId, user.role);
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
  async updateMyStatus(
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdatePartnerStatusDto,
  ) {
    // Someone whose account is being deleted cannot go back online.
    if (dto.isAvailable === true) await this.deletion.assertNotLeaving(user.userId);

    // Vehicle and phone changes are checked and saved first; if they fail,
    // nothing else is changed.
    const edit = await this.profileService.update(user.userId, dto);

    const profile =
      dto.isAvailable !== undefined
        ? await this.logisticsService.updatePartnerStatus(user.userId, dto)
        : await this.logisticsService.getMyProfile(user.userId);

    return edit ? { ...profile, ...edit } : profile;
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
    void this.presence.touch(user.userId); // the app's refresh doubles as a heartbeat
    return this.logisticsService.myDeliveries(user.userId, query);
  }

  /**
   * Latest position, sent about every 60 seconds while online. Only the
   * latest position is kept. A partner who is offline gets 409.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Put('me/location')
  updateLocation(
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateLocationDto,
  ) {
    return this.presence.updateLocation(user.userId, dto);
  }

  /**
   * "Still here", for when the app has no location permission.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('me/heartbeat')
  heartbeat(@CurrentUser() user: { userId: string }) {
    return this.presence.heartbeat(user.userId);
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
