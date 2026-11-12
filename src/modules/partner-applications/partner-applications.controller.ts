import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import {
  ApprovePartnerApplicationDto,
  CreatePartnerApplicationDto,
  PartnerApplicationQueryDto,
  RejectPartnerApplicationDto,
} from './dto/partner-application.dto';
import { PartnerApplicationsService } from './partner-applications.service';

// Public: the Delivery app's "Become a partner" flow, before any account exists.
@Controller('partner-applications')
export class PartnerApplicationsController {
  constructor(private readonly applications: PartnerApplicationsService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  apply(@Body() dto: CreatePartnerApplicationDto) {
    return this.applications.apply(dto);
  }
}

// Admin console. Writes are recorded by the audit log automatically.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.ADMIN)
@Controller('admin/partner-applications')
export class AdminPartnerApplicationsController {
  constructor(private readonly applications: PartnerApplicationsService) {}

  @Get()
  list(@Query() q: PartnerApplicationQueryDto) {
    return this.applications.list(q.status);
  }

  // Creates the DELIVERY_PARTNER account with this temporary password.
  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() user: { userId: string }, @Body() dto: ApprovePartnerApplicationDto) {
    return this.applications.approve(id, user.userId, dto.password);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() user: { userId: string }, @Body() dto: RejectPartnerApplicationDto) {
    return this.applications.reject(id, user.userId, dto.reason);
  }
}
