import { IsEnum } from 'class-validator';
import { LaundryStatus } from '@prisma/client';

export class UpdateLaundryStatusDto {
  @IsEnum(LaundryStatus)
  status: LaundryStatus;
}
