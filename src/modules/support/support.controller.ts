import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { SupportService, SupportUser } from './support.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ReplyTicketDto } from './dto/reply-ticket.dto';
import { TicketsQueryDto } from './dto/tickets-query.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

// Works for customers and staff: the account's role decides whose tickets
// these are.
@UseGuards(JwtAuthGuard)
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('tickets')
  create(@CurrentUser() user: SupportUser, @Body() dto: CreateTicketDto) {
    return this.supportService.create(user, dto);
  }

  @Get('tickets')
  findMine(@CurrentUser() user: SupportUser) {
    return this.supportService.findMine(user);
  }

  // Fixed routes must stay above ':id'.
  @UseGuards(RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Get('tickets/all')
  findAll(@Query() q: TicketsQueryDto) {
    return this.supportService.findAll(q.status, q.limit);
  }

  @Get('tickets/:id')
  findOne(@Param('id') id: string, @CurrentUser() user: SupportUser) {
    return this.supportService.findOne(id, user);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('tickets/:id/messages')
  reply(@Param('id') id: string, @CurrentUser() user: SupportUser, @Body() dto: ReplyTicketDto) {
    return this.supportService.reply(id, user, dto.body);
  }

  @UseGuards(RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Patch('tickets/:id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTicketStatusDto) {
    return this.supportService.updateStatus(id, dto);
  }
}
