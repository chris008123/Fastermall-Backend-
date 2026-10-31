import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PreferencesService } from './preferences.service';
import { PartnerPreferencesDto } from './dto/partner-preferences.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.DELIVERY_PARTNER)
@Controller('logistics/me/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  get(@CurrentUser() user: { userId: string }) {
    return this.preferences.get(user.userId);
  }

  // Partial: only the sections and keys you send change.
  @Put()
  update(@CurrentUser() user: { userId: string }, @Body() dto: PartnerPreferencesDto) {
    return this.preferences.update(user.userId, dto);
  }
}
