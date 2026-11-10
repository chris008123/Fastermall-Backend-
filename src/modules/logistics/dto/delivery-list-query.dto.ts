import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { DeliveryStatus } from '@prisma/client';

// All optional. With none of them, both delivery lists answer exactly as
// before (a plain array).
export class DeliveryListQueryDto {
  // ?status=DELIVERED or ?status=PICKED_UP,EN_ROUTE_TO_CUSTOMER
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value,
  )
  @IsEnum(DeliveryStatus, { each: true })
  status?: DeliveryStatus[];

  // Asking for a page switches the answer to { items, nextCursor }.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  // Only jobs changed after this moment. Use the X-Server-Time header of the
  // previous answer, not the phone's clock.
  @IsOptional()
  @IsISO8601()
  updatedSince?: string;
}
