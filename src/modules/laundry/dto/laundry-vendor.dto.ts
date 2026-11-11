import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateLaundryVendorDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  name!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  description?: string;

  // An https link to the vendor's logo.
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  logoUrl?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(200)
  location?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(20)
  phone?: string;

  @IsOptional() @IsBoolean()
  isOpen?: boolean;

  // Fastermall's share in percent (stored only; settlement is not built).
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  commissionRate?: number;

  // New vendors start PENDING unless the admin approves them straight away.
  @IsOptional() @IsIn(['PENDING', 'APPROVED'])
  status?: 'PENDING' | 'APPROVED';
}

export class UpdateLaundryVendorDto extends PartialType(CreateLaundryVendorDto) {}

export class LaundryVendorStatusDto {
  @IsIn(['PENDING', 'APPROVED', 'SUSPENDED'])
  status!: 'PENDING' | 'APPROVED' | 'SUSPENDED';
}

export class AdminVendorQueryDto {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'SUSPENDED'])
  status?: string;
}

export class CreateLaundryServiceDto {
  // e.g. "Wash & fold (per kg)", "Duvet".
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  name!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(300)
  description?: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  unitPrice!: number;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class UpdateLaundryServiceDto extends PartialType(CreateLaundryServiceDto) {}

export class AssignLaundryVendorDto {
  // null = back to Fastermall Laundry.
  @IsOptional() @IsString() @MaxLength(64)
  vendorId?: string | null;
}

export class UpsertLaundryReviewDto {
  @IsInt() @Min(1) @Max(5)
  rating!: number;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  comment?: string;
}

export class ReviewsPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  pageSize?: number;
}
