import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PayDto } from './dto/pay.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('pay')
  pay(@Body() dto: PayDto) {
    return this.paymentsService.pay(dto);
  }

  @Get()
  findMine(@CurrentUser() user: { userId: string }) {
    return this.paymentsService.findMyPayments(user.userId);
  }
}
