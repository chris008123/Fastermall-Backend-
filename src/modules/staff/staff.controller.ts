import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StaffService } from './staff.service';
import { LoginStaffDto } from './dto/login-staff.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import { ForgotStaffPasswordDto } from './dto/forgot-staff-password.dto';
import { ResetStaffPasswordDto } from './dto/reset-staff-password.dto';
import { ChangeStaffPasswordDto } from './dto/change-staff-password.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { SetStaffActiveDto } from './dto/set-staff-active.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { StaffRole } from '@prisma/client';

@Controller('staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  // Public, but self-closing after the first admin exists — see staff.service.ts
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('bootstrap-admin')
  bootstrapAdmin(@Body() dto: BootstrapAdminDto) {
    return this.staffService.bootstrapAdmin(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginStaffDto) {
    return this.staffService.login(dto);
  }

  // Public: the access token has usually expired by the time this is called.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.staffService.refresh(dto.refreshToken);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('password/forgot')
  forgotPassword(@Body() dto: ForgotStaffPasswordDto) {
    return this.staffService.forgotPassword(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/reset')
  resetPassword(@Body() dto: ResetStaffPasswordDto) {
    return this.staffService.resetPassword(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('password/change')
  changePassword(
    @CurrentUser() user: { userId: string; sessionId?: string },
    @Body() dto: ChangeStaffPasswordDto,
  ) {
    return this.staffService.changePassword(user.userId, user.sessionId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@CurrentUser() user: { sessionId?: string }) {
    return this.staffService.logout(user.sessionId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { userId: string }) {
    return this.staffService.getProfile(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Post('users')
  createStaff(@Body() dto: CreateStaffDto) {
    return this.staffService.createStaff(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Get('users')
  findAll() {
    return this.staffService.findAll();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Patch('users/:id/active')
  setActive(
    @Param('id') id: string,
    @Body() dto: SetStaffActiveDto,
    @CurrentUser() user: { userId: string },
  ) {
    return this.staffService.setActive(id, dto.isActive, user.userId);
  }
}
