import { Controller, Get, UseGuards } from '@nestjs/common';
import { LaundryService } from './laundry.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';

@Controller('laundry')
export class LaundryController {
  constructor(private readonly laundryService: LaundryService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll() {
    return this.laundryService.findAll();
  }
}
