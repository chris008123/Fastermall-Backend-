import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreatePayoutDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100_000)
  amount: number;

  @IsOptional()
  @IsIn(['MOBILE_MONEY', 'CASH', 'BANK'])
  method?: string;

  // e.g. the mobile-money transaction id
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
