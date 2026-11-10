import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

// Query string shared by the admin list endpoints. `status` and `type` are
// checked against the right enum in AdminService, because each list has its
// own set of values.
export class AdminListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Values above 100 are accepted and capped at 100.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  type?: string;

  // Orders: only those whose delivery window is on this day (Ghana time),
  // e.g. 2026-11-08. The list is then sorted by window instead of by date.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'deliveryDate must look like 2026-11-08' })
  deliveryDate?: string;
}
