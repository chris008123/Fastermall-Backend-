import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateOptionGroupDto {
  // e.g. "Beans portion", "Extras".
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  name!: string;

  // 0 = optional. 1 = the customer must pick one.
  @IsOptional() @IsInt() @Min(0) @Max(20)
  minSelect?: number;

  // How many different options may be picked.
  @IsOptional() @IsInt() @Min(1) @Max(20)
  maxSelect?: number;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  sortOrder?: number;
}

export class UpdateOptionGroupDto extends PartialType(CreateOptionGroupDto) {}

export class CreateOptionDto {
  // e.g. "Beans (GH₵5)", "Egg".
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  name!: string;

  // What it adds to the item's price, in GH₵ (may be 0).
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  price?: number;

  // How many of this one a customer may take (e.g. 3 eggs).
  @IsOptional() @IsInt() @Min(1) @Max(20)
  maxQuantity?: number;

  @IsOptional() @IsBoolean()
  isAvailable?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  sortOrder?: number;
}

export class UpdateOptionDto extends PartialType(CreateOptionDto) {}
