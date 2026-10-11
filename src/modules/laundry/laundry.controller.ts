import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { LaundryService } from './laundry.service';
import { CreateLaundryOrderDto } from './dto/create-laundry-order.dto';
import { UpdateLaundryStatusDto } from './dto/update-laundry-status.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { StaffRole } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('laundry')
export class LaundryController {
  constructor(private readonly laundryService: LaundryService) {}

  @Get('catalog')
  getCatalog() {
    return this.laundryService.getCatalog();
  }

  @Post('orders')
  create(@CurrentUser() user: { userId: string }, @Body() dto: CreateLaundryOrderDto) {
    return this.laundryService.createOrder(user.userId, dto);
  }

  @Get('orders')
  findMine(@CurrentUser() user: { userId: string }) {
    return this.laundryService.findMyOrders(user.userId);
  }

  @Get('orders/:id')
  findOne(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id') id: string,
  ) {
    return this.laundryService.findOne(id, user);
  }

  @UseGuards(RolesGuard)
  @Roles(StaffRole.ADMIN, StaffRole.LAUNDRY_STAFF)
  @Patch('orders/:id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateLaundryStatusDto) {
    return this.laundryService.updateStatus(id, dto);
  }
}
