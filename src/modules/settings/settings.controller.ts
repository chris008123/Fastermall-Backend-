import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // Public: what the apps need to show prices and a maintenance banner.
  @Get('settings')
  async publicSettings() {
    const s = await this.settings.getAll();
    return {
      marketplaceDeliveryFee: s.marketplaceDeliveryFee,
      laundryPickupFee: s.laundryPickupFee,
      maintenanceMode: s.maintenanceMode,
      maintenanceMessage: s.maintenanceMode ? s.maintenanceMessage : null,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Get('admin/settings')
  getAll() {
    return this.settings.getAll();
  }

  // Body: any subset of the settings, e.g. { "maintenanceMode": true }.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Patch('admin/settings')
  update(@CurrentUser() user: { userId: string }, @Body() dto: UpdateSettingsDto) {
    return this.settings.update({ ...dto }, user.userId);
  }
}
