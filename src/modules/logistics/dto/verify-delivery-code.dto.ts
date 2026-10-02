import { IsString, Matches } from 'class-validator';

export class VerifyDeliveryCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'Delivery code must be exactly 6 digits',
  })
  code: string;
}
