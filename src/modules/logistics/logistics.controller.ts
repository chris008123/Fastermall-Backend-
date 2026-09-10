import { Controller, Get, UseGuards } from '@nestjs/common';
import { LogisticsService } from './logistics.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';

@Controller('logistics')
export class LogisticsController {
  constructor(private readonly logisticsService: LogisticsService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll() {
    return this.logisticsService.findAll();
  }
}
