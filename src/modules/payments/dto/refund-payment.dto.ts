import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefundPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
