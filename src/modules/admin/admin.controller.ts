import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { BroadcastDto } from './dto/broadcast.dto';
import { TestPushDto } from './dto/test-push.dto';
import { CreatePayoutDto } from './dto/create-payout.dto';
import { AdminService } from './admin.service';
import { AdminListQueryDto } from './dto/admin-list-query.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { StaffRole } from '@prisma/client';

// Views across every customer for the admin console, plus partner payouts,
// broadcasts and the audit log. Status changes go through each module's own
// PATCH route.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly notifications: NotificationsService,
  ) {}

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

  // :staffId is the partner's staff account id (as in GET /admin/partners).
  @Get('partners/:staffId/payouts')
  listPayouts(@Param('staffId') staffId: string) {
    return this.adminService.listPayouts(staffId);
  }

  @Post('partners/:staffId/payouts')
  createPayout(
    @CurrentUser() user: { userId: string },
    @Param('staffId') staffId: string,
    @Body() dto: CreatePayoutDto,
  ) {
    return this.adminService.createPayout(staffId, dto, user.userId);
  }

  @Post('notifications/broadcast')
  broadcast(@Body() dto: BroadcastDto) {
    return this.notifications.broadcast(dto.audience, dto.title, dto.body);
  }

  // Test push to one customer's or staff member's phones, with Expo's answer
  // per phone. Body: { userId } or { staffUserId }.
  @Post('notifications/test')
  testPush(@Body() dto: TestPushDto) {
    return this.notifications.sendTestPushTo(dto);
  }

  // ?page=1&pageSize=50
  @Get('audit-logs')
  listAuditLogs(@Query() query: AdminListQueryDto) {
    return this.adminService.listAuditLogs(query);
  }
}
