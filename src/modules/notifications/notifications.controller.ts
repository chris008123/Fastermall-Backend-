import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NotificationsService, NotificationUser } from './notifications.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

// Works for both customers and staff: the JWT role decides which owner
// (User or StaffUser) the notifications and devices belong to.
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findMine(@CurrentUser() user: NotificationUser) {
    return this.notificationsService.findMine(user);
  }

  // Register this phone's Expo push token (idempotent — safe to call on every launch/login).
  @Post('devices')
  registerDevice(@CurrentUser() user: NotificationUser, @Body() dto: RegisterDeviceDto) {
    return this.notificationsService.registerDevice(user, dto);
  }

  // Refresh a token, optionally replacing `previousToken` when Expo rotates it.
  @Patch('devices')
  updateDevice(@CurrentUser() user: NotificationUser, @Body() dto: RegisterDeviceDto) {
    return this.notificationsService.registerDevice(user, dto);
  }

  // Call on logout so this phone stops receiving the account's pushes.
  // The token can be sent in the body or as ?token=.
  @Delete('devices')
  removeDevice(
    @CurrentUser() user: NotificationUser,
    @Body() body: { token?: string } | undefined,
    @Query('token') queryToken?: string,
  ) {
    const token = body?.token ?? queryToken;
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('token is required');
    }
    return this.notificationsService.removeDevice(user, token);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: NotificationUser) {
    return this.notificationsService.markRead(id, user);
  }
}
