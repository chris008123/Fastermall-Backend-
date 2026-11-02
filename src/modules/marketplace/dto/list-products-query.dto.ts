import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const PRODUCT_SORTS = [
  'relevance',
  'popular',
  'rating',
  'price_asc',
  'price_desc',
] as const;

export type ProductSort = (typeof PRODUCT_SORTS)[number];

// Query string for GET /marketplace/products. Every field is optional.
export class ListProductsQueryDto {
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Values above 100 are accepted and capped at 100 by the service.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  // relevance (default) = newest first; popular = most often ordered.
  @IsOptional()
  @IsIn(PRODUCT_SORTS)
  sort?: ProductSort;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  // Products with no reviews yet are left out when this is set.
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(5)
  minRating?: number;

  // ?inStock=true limits the list to products with stock left.
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  inStock?: boolean;
}
