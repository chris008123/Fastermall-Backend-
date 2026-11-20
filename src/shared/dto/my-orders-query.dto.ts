import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Most a customer's order list returns in one request when `take` is given. */
export const MY_ORDERS_MAX_TAKE = 100;

// Optional query for a customer's own order lists. With no parameters the
// endpoints still return every order, so older app versions keep working.
export class MyOrdersQueryDto {
  // Only the newest N orders. The app asks for one more than it shows, to tell
  // whether there are more.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MY_ORDERS_MAX_TAKE)
  take?: number;

  // GET /orders only: marketplace or food orders.
  @IsOptional()
  @IsIn(['MARKETPLACE', 'FOOD'])
  type?: 'MARKETPLACE' | 'FOOD';
}
