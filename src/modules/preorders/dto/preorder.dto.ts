import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreatePreOrderDto {
  // Optional: the product (and design) this is about. Leave both out for a
  // fully custom request.
  @IsOptional() @IsString() @MaxLength(64)
  productId?: string;

  @IsOptional() @IsString() @MaxLength(64)
  variantId?: string;

  // What the customer wants, in their own words.
  @Transform(trim) @IsString() @MinLength(10) @MaxLength(2000)
  description!: string;

  // Extra details as label -> value, e.g. { "Size": "42", "Colour": "brown" }.
  // Checked in the service (at most 20 entries, text only).
  @IsOptional() @IsObject()
  specifications?: Record<string, string>;

  @IsOptional() @IsInt() @Min(1) @Max(20)
  quantity?: number;
}

export class CustomerNoteDto {
  // Optional reason when declining or cancelling.
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  note?: string;
}

export class QuotePreOrderDto {
  // Total price for the whole request (all units), GH₵.
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100_000)
  price!: number;

  @IsISO8601({ strict: true })
  estimatedDate!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  note?: string;
}

export class AdminPreOrderStatusDto {
  @IsIn(['FULFILLED', 'CANCELLED'])
  status!: 'FULFILLED' | 'CANCELLED';

  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  note?: string;
}

export class AdminPreOrderQueryDto {
  @IsOptional() @IsIn(['SUBMITTED', 'QUOTED', 'ACCEPTED', 'DECLINED', 'FULFILLED', 'CANCELLED'])
  status?: string;
}

export class CreateVariantDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  name!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(300)
  description?: string;

  // Added to the product price; negative takes some off.
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-100_000) @Max(100_000)
  priceDelta?: number;

  // An https image (e.g. one of the product's uploaded photos).
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  imageUrl?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  sortOrder?: number;
}

export class UpdateVariantDto extends PartialType(CreateVariantDto) {}
