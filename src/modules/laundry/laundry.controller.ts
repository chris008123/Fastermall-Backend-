import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { parseIdempotencyKey } from '../../shared/utils/idempotency';
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

  // ?vendorId= for one vendor's services; without it, Fastermall Laundry's
  // (what older apps expect).
  @Get('catalog')
  getCatalog(@Query('vendorId') vendorId?: string) {
    return this.laundryService.getCatalog(vendorId || undefined);
  }

  // Laundry staff: their vendor's orders. Admins: all, or ?vendorId=.
  // Optional ?status=WASHING. Declared before 'orders/:id'.
  @UseGuards(RolesGuard)
  @Roles(StaffRole.ADMIN, StaffRole.LAUNDRY_STAFF)
  @Get('staff/orders')
  staffOrders(
    @CurrentUser() user: { userId: string; role?: string },
    @Query('status') status?: string,
    @Query('vendorId') vendorId?: string,
  ) {
    return this.laundryService.staffOrders(user, { status, vendorId });
  }

  @Post('orders')
  create(
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateLaundryOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.laundryService.createOrder(
      user.userId,
      dto,
      parseIdempotencyKey(idempotencyKey),
    );
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
  updateStatus(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id') id: string,
    @Body() dto: UpdateLaundryStatusDto,
  ) {
    return this.laundryService.updateStatus(id, dto, user);
  }
}
