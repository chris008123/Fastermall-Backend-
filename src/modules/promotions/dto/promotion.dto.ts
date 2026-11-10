import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsHexColor,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PromotionCtaType, PromotionFrequency } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Animation presets the app knows how to play for the popup.
export const PROMOTION_ANIMATIONS = ['none', 'fade', 'slide', 'bounce', 'confetti', 'float3d'] as const;

export class PromotionThemeDto {
  @IsOptional() @IsHexColor() background?: string;
  @IsOptional() @IsHexColor() textColor?: string;
  @IsOptional() @IsHexColor() accentColor?: string;
  @IsOptional() @IsIn(PROMOTION_ANIMATIONS as unknown as string[]) animation?: string;
}

export class CreatePromotionDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  title!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(120)
  subtitle?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  body?: string;

  // An image already hosted elsewhere. To upload one, use
  // POST /admin/promotions/:id/image instead.
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  imageUrl?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(30)
  ctaLabel?: string;

  // What the button opens: a product, category, marketplace vendor, food
  // vendor (ctaValue = its id) or a web page (ctaValue = https URL).
  @IsOptional() @IsEnum(PromotionCtaType)
  ctaType?: PromotionCtaType;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  ctaValue?: string;

  @IsOptional() @ValidateNested() @Type(() => PromotionThemeDto)
  theme?: PromotionThemeDto;

  // Defaults to now.
  @IsOptional() @IsISO8601({ strict: true })
  startsAt?: string;

  // Leave out (or null) for no end date.
  @IsOptional() @IsISO8601({ strict: true })
  endsAt?: string | null;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  priority?: number;

  @IsOptional() @IsEnum(PromotionFrequency)
  frequency?: PromotionFrequency;
}

export class UpdatePromotionDto extends PartialType(CreatePromotionDto) {}

export const PROMOTION_STATUSES = ['live', 'scheduled', 'ended', 'inactive'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export class AdminPromotionQueryDto {
  @IsOptional() @IsIn(PROMOTION_STATUSES as unknown as string[])
  status?: PromotionStatus;
}
