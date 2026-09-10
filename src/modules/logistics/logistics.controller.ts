import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { LogisticsService } from './logistics.service';
import { UpdatePartnerStatusDto } from './dto/update-partner-status.dto';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { StaffRole } from '@prisma/client';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.DELIVERY_PARTNER, StaffRole.ADMIN)
@Controller('logistics')
export class LogisticsController {
  constructor(private readonly logisticsService: LogisticsService) {}

  @Get('deliveries/unassigned')
  findUnassigned() {
    return this.logisticsService.findUnassigned();
  }

  @Post('deliveries/:id/claim')
  claim(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.logisticsService.claim(id, user.userId);
  }

  @Patch('deliveries/:id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateDeliveryStatusDto) {
    return this.logisticsService.updateStatus(id, dto);
  }

  @Patch('me')
  updateMyStatus(@CurrentUser() user: { userId: string }, @Body() dto: UpdatePartnerStatusDto) {
    return this.logisticsService.updatePartnerStatus(user.userId, dto);
  }

  @Get('me/deliveries')
  myDeliveries(@CurrentUser() user: { userId: string }) {
    return this.logisticsService.myDeliveries(user.userId);
  }

  @Get('me/earnings')
  myEarnings(@CurrentUser() user: { userId: string }) {
    return this.logisticsService.myEarnings(user.userId);
  }
}
