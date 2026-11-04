import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminListQueryDto } from './dto/admin-list-query.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { StaffRole } from '@prisma/client';

// Read-only views across every customer, for the admin console. Status
// changes still go through each module's own PATCH route.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard')
  dashboard() {
    return this.adminService.dashboardStats();
  }

  @Get('users')
  findAllUsers() {
    return this.adminService.findAllUsers();
  }

  // ?status=PENDING&type=FOOD&page=1&pageSize=20
  @Get('orders')
  listOrders(@Query() query: AdminListQueryDto) {
    return this.adminService.listOrders(query);
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string) {
    return this.adminService.getOrder(id);
  }

  // ?status=WASHING&page=1
  @Get('laundry-orders')
  listLaundryOrders(@Query() query: AdminListQueryDto) {
    return this.adminService.listLaundryOrders(query);
  }

  // ?status=EN_ROUTE_TO_CUSTOMER&page=1
  @Get('deliveries')
  listDeliveries(@Query() query: AdminListQueryDto) {
    return this.adminService.listDeliveries(query);
  }

  // ?status=PENDING&page=1
  @Get('payments')
  listPayments(@Query() query: AdminListQueryDto) {
    return this.adminService.listPayments(query);
  }

  @Get('partners')
  listPartners() {
    return this.adminService.listPartners();
  }
}
