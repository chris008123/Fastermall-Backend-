import { IsEnum } from 'class-validator';
import { DeliveryStatus } from '@prisma/client';

export class UpdateDeliveryStatusDto {
  @IsEnum(DeliveryStatus)
  status: DeliveryStatus;
}
