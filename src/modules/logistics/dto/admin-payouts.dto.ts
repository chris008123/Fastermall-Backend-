import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PayoutStatus } from '@prisma/client';

export class AdminPayoutsQueryDto {
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class SetPayoutStatusDto {
  @IsIn(['PAID', 'FAILED'])
  status: 'PAID' | 'FAILED';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  failureReason?: string;
}
