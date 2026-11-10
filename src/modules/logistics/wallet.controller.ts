import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';

import { WalletService } from './wallet.service';
import { CashOutDto } from './dto/cash-out.dto';
import { ConfirmPasswordDto } from './dto/confirm-password.dto';
import { LedgerQueryDto } from './dto/ledger-query.dto';
import { SetPayoutDestinationDto } from './dto/set-payout-destination.dto';
import { AdminPayoutsQueryDto, SetPayoutStatusDto } from './dto/admin-payouts.dto';

import { IdempotencyInterceptor } from '../../shared/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('logistics')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Roles(StaffRole.DELIVERY_PARTNER)
  @Get('me/wallet')
  getWallet(@CurrentUser() user: { userId: string }) {
    return this.wallet.getWallet(user.userId);
  }

  @Roles(StaffRole.DELIVERY_PARTNER)
  @Get('me/wallet/ledger')
  ledger(@CurrentUser() user: { userId: string }, @Query() q: LedgerQueryDto) {
    return this.wallet.ledger(user.userId, q.limit, q.cursor);
  }

  // Money moves here, so the Idempotency-Key header is required: a retry after
  // a timeout then returns the first result instead of cashing out twice.
  @Roles(StaffRole.DELIVERY_PARTNER)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post('me/cash-out')
  cashOut(
    @CurrentUser() user: { userId: string },
    @Body() dto: CashOutDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        message: 'Send an Idempotency-Key header with a cash-out',
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      });
    }
    return this.wallet.cashOut(user.userId, dto.amountPesewas);
  }

  @Roles(StaffRole.DELIVERY_PARTNER)
  @Get('me/payout-destination')
  getDestination(@CurrentUser() user: { userId: string }) {
    return this.wallet.getPayoutDestination(user.userId);
  }

  @Roles(StaffRole.DELIVERY_PARTNER)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Put('me/payout-destination')
  setDestination(@CurrentUser() user: { userId: string }, @Body() dto: SetPayoutDestinationDto) {
    return this.wallet.setPayoutDestination(user.userId, dto);
  }

  @Roles(StaffRole.DELIVERY_PARTNER)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Delete('me/payout-destination')
  removeDestination(@CurrentUser() user: { userId: string }, @Body() dto: ConfirmPasswordDto) {
    return this.wallet.removePayoutDestination(user.userId, dto.password);
  }

  // ---- Admin ----

  @Roles(StaffRole.ADMIN)
  @Get('admin/payouts')
  adminList(@Query() q: AdminPayoutsQueryDto) {
    return this.wallet.adminListPayouts(q.status, q.limit);
  }

  @Roles(StaffRole.ADMIN)
  @Patch('admin/payouts/:id')
  adminSetStatus(@Param('id') id: string, @Body() dto: SetPayoutStatusDto) {
    return this.wallet.adminSetPayoutStatus(id, dto.status, dto.failureReason);
  }
}
