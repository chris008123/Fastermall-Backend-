import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateFaqDto {
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  question!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(5000)
  answer!: string;

  // Groups questions in the app, e.g. "Orders", "Payments", "Laundry".
  // An empty string removes the category.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  category?: string;

  // Lower comes first within a category.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  // Unpublished questions are kept but not shown in the apps.
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateFaqDto extends PartialType(CreateFaqDto) {}

export class FaqQueryDto {
  // Only questions in this category.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  category?: string;
}
