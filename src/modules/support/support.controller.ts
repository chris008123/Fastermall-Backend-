import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { SupportService } from './support.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { StaffRole } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post('tickets')
  create(@CurrentUser() user: { userId: string }, @Body() dto: CreateTicketDto) {
    return this.supportService.create(user.userId, dto);
  }

  @Get('tickets')
  findMine(@CurrentUser() user: { userId: string }) {
    return this.supportService.findMine(user.userId);
  }

  @UseGuards(RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Get('tickets/all')
  findAll() {
    return this.supportService.findAll();
  }

  @UseGuards(RolesGuard)
  @Roles(StaffRole.ADMIN)
  @Patch('tickets/:id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTicketStatusDto) {
    return this.supportService.updateStatus(id, dto);
  }
}
