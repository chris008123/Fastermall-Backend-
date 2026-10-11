import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class InitializePaymentDto {
  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsString()
  laundryOrderId?: string;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;
}
