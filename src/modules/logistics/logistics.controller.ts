import {
  Body,
  Controller,
  Get,
  GoneException,
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
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { DeliveryListQueryDto } from './dto/delivery-list-query.dto';
import { ProfileService } from './profile.service';
import { DocumentsService } from './documents.service';
import { PresenceService } from './presence.service';
import { UpdateLocationDto } from './dto/update-location.dto';
import { LogisticsService } from './logistics.service';
import { IdempotencyInterceptor } from '../../shared/interceptors/idempotency.interceptor';

import { UpdatePartnerStatusDto } from './dto/update-partner-status.dto';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto';
import { VerifyDeliveryCodeDto } from './dto/verify-delivery-code.dto';

import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

export const RIDER_LOCATION_REMOVED_MESSAGE =
  'Location sharing has been removed. Update the app to the latest version.';

type Caller = { userId: string; role: string };

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.DELIVERY_PARTNER, StaffRole.ADMIN)
@Controller('logistics')
export class LogisticsController {
  constructor(
    private readonly logisticsService: LogisticsService,
    private readonly presence: PresenceService,
    private readonly documents: DocumentsService,
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
    @CurrentUser() user: Caller,
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
    @CurrentUser() user: Caller,
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
    @CurrentUser() user: Caller,
  ) {
    return this.claim(id, user);
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post('deliveries/:id/claim')
  async claim(
    @Param('id') id: string,
    @CurrentUser() user: Caller,
  ) {
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
   * The logged-in user's ID and role are passed to the service so it can
   * check the caller is the one who accepted the delivery (the partner for
   * food, the admin for marketplace and laundry).
   */
  @UseInterceptors(IdempotencyInterceptor)
  @Patch('deliveries/:id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryStatusDto,
    @CurrentUser() user: Caller,
  ) {
    return this.logisticsService.updateStatus(
      id,
      dto,
      user.userId,
      user.role,
    );
  }

  /**
   * Removed: live maps and rider location tracking were taken out of the
   * apps (Nov 2026). Kept as a route so older app versions get a clear 410
   * instead of a 404, and stop retrying.
   */
  @SkipThrottle()
  @Patch('deliveries/:id/location')
  updateRiderLocation() {
    throw new GoneException(RIDER_LOCATION_REMOVED_MESSAGE);
  }

  /**
   * The signed-in partner's profile.
   */
  @Get('me')
  me(@CurrentUser() user: { userId: string }) {
    return this.logisticsService.getMyProfile(user.userId);
  }

  /**
   * Update delivery partner availability (and vehicle / phone details).
   */
  @Patch('me')
  async updateMyStatus(
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdatePartnerStatusDto,
  ) {
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
   * Deliveries assigned to the current partner, or for an admin the
   * marketplace and laundry deliveries they accepted.
   */
  // X-Server-Time is taken BEFORE the query, so a job that changes while the
  // query runs is picked up by the next `updatedSince` poll instead of lost.
  @Header('Cache-Control', 'private, no-cache')
  @Get('me/deliveries')
  myDeliveries(
    @CurrentUser() user: Caller,
    @Query() query: DeliveryListQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('X-Server-Time', new Date().toISOString());
    void this.presence.touch(user.userId); // the app's refresh doubles as a heartbeat
    return this.logisticsService.myDeliveries(user.userId, user.role, query);
  }

  /**
   * Live location was removed (Nov 2026). Still accepted so app versions
   * that send it keep working, but the coordinates are ignored and nothing
   * is stored: it only counts as "still here", like the heartbeat.
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
   * "Still here", so a partner stays online while the app is open.
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
