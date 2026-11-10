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
import { NotificationsQueryDto } from './dto/notifications-query.dto';
import { SetReadDto } from './dto/set-read.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

// Works for both customers and staff: the JWT role decides which owner
// (User or StaffUser) the notifications and devices belong to.
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findMine(@CurrentUser() user: NotificationUser, @Query() query: NotificationsQueryDto) {
    return this.notificationsService.findMine(user, query);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: NotificationUser) {
    return this.notificationsService.unreadCount(user);
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

  // Marks every unread notification read in one request.
  // Must stay above ':id' routes so "read-all" is not read as an id.
  @Patch('read-all')
  markAllRead(@CurrentUser() user: NotificationUser) {
    return this.notificationsService.markAllRead(user);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: NotificationUser) {
    return this.notificationsService.markRead(id, user);
  }

  // Read or unread: { "isRead": false } puts it back as unread.
  @Patch(':id')
  setRead(@Param('id') id: string, @CurrentUser() user: NotificationUser, @Body() dto: SetReadDto) {
    return this.notificationsService.setRead(id, user, dto.isRead);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: NotificationUser) {
    return this.notificationsService.remove(id, user);
  }
}

// The same device routes at the short path the partner app was told about:
// POST/PATCH/DELETE /devices.
@UseGuards(JwtAuthGuard)
@Controller('devices')
export class DevicesController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post()
  register(@CurrentUser() user: NotificationUser, @Body() dto: RegisterDeviceDto) {
    return this.notificationsService.registerDevice(user, dto);
  }

  @Patch()
  update(@CurrentUser() user: NotificationUser, @Body() dto: RegisterDeviceDto) {
    return this.notificationsService.registerDevice(user, dto);
  }

  @Delete()
  remove(
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
}
