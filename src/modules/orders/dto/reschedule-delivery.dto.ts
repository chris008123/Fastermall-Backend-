import { IsISO8601 } from 'class-validator';

export class RescheduleDeliveryDto {
  // The `start` of one of the options from GET /orders/:id/delivery-windows.
  @IsISO8601({ strict: true })
  windowStart!: string;
}
