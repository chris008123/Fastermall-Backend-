import { Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { parseIdempotencyKey } from '../../shared/utils/idempotency';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { RescheduleDeliveryDto } from './dto/reschedule-delivery.dto';
import { CustomerGuard } from '../../shared/guards/customer.guard';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { StaffRole } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @UseGuards(CustomerGuard)
  @Post()
  create(
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.ordersService.createOrder(
      user.userId,
      dto,
      parseIdempotencyKey(idempotencyKey),
    );
  }

  @UseGuards(CustomerGuard)
  @Get()
  findMine(@CurrentUser() user: { userId: string }) {
    return this.ordersService.findMyOrders(user.userId);
  }

  // The order's delivery window and the windows it may be moved to.
  @UseGuards(CustomerGuard)
  @Get(':id/delivery-windows')
  deliveryWindows(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
  ) {
    return this.ordersService.getDeliveryWindows(id, user.userId);
  }

  // Body: { windowStart } from one of the options above.
  @UseGuards(CustomerGuard)
  @Patch(':id/delivery-window')
  rescheduleDelivery(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Body() dto: RescheduleDeliveryDto,
  ) {
    return this.ordersService.rescheduleDelivery(id, user.userId, dto.windowStart);
  }

  // The customer cancels their own order before it is being prepared.
  @UseGuards(CustomerGuard)
  @Post(':id/cancel')
  cancel(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.ordersService.cancelByCustomer(id, user.userId);
  }

  @UseGuards(CustomerGuard)
  @Get(':id')
  findOne(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
  ) {
    return this.ordersService.findOne(id, user.userId);
  }
  
  @UseGuards(RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.ordersService.updateStatus(id, dto);
  }
}
