import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { StaffService } from './staff.service';
import { LoginStaffDto } from './dto/login-staff.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { StaffRole } from '@prisma/client';

@Controller('staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  // Public, but self-closing after the first admin exists — see staff.service.ts
  @Post('bootstrap-admin')
  bootstrapAdmin(@Body() dto: BootstrapAdminDto) {
    return this.staffService.bootstrapAdmin(dto);
  }

  @Post('login')
  login(@Body() dto: LoginStaffDto) {
    return this.staffService.login(dto);
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
}
