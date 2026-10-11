import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { InitializePaymentDto } from './dto/initialize-payment.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('initialize')
  initialize(@CurrentUser() user: { userId: string }, @Body() dto: InitializePaymentDto) {
    return this.paymentsService.initialize(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('verify/:reference')
  verify(@CurrentUser() user: { userId: string }, @Param('reference') reference: string) {
    return this.paymentsService.verify(user.userId, reference);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  findMine(@CurrentUser() user: { userId: string }) {
    return this.paymentsService.findMyPayments(user.userId);
  }

  // Called by the payment provider, not the app: authenticated by signature.
  @SkipThrottle()
  @Post('webhook')
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string | undefined,
    @Body() body: unknown,
  ) {
    return this.paymentsService.handleWebhook(req.rawBody, signature, body);
  }

  // Where the provider sends the customer's browser after checkout. The app
  // closes the in-app browser and calls GET /payments/verify/:reference, so
  // this page only needs to say "you can go back". It reflects no input.
  @SkipThrottle()
  @Get('callback')
  callback(@Res() res: Response) {
    res
      .type('html')
      .send(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment</title></head>' +
          '<body style="font-family:sans-serif;text-align:center;padding:48px 24px">' +
          '<h2>Thanks!</h2><p>You can close this window and return to Fastermall.</p></body></html>',
      );
  }
}
