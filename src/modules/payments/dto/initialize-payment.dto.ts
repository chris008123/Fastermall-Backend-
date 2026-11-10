import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  ACCEPTED_PAYMENT_METHODS,
  AcceptedPaymentMethod,
  CASH_REMOVED_MESSAGE,
} from '../payment-methods';

export class InitializePaymentDto {
  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsString()
  laundryOrderId?: string;

  // CASH is refused: every payment goes through the online provider.
  @IsIn(ACCEPTED_PAYMENT_METHODS, {
    message: (args) =>
      String(args.value).toUpperCase() === 'CASH'
        ? CASH_REMOVED_MESSAGE
        : `method must be one of: ${ACCEPTED_PAYMENT_METHODS.join(', ')}`,
  })
  method: AcceptedPaymentMethod;
}
