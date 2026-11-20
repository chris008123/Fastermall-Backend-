import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsHexColor,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PromotionCtaType, PromotionFrequency } from '@prisma/client';
import {
  ANIMATION_LIMITS as L,
  LEGACY_ANIMATIONS,
  LOOP_INTENSITIES,
  LOTTIE_PLACEMENTS,
  NO_ANIMATION,
  presetKeys,
  SLIDE_DIRECTIONS,
} from '../animations';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);


// How the popup appears.
export class EntranceDto {
  @IsIn([NO_ANIMATION, ...presetKeys('entrance')]) preset!: string;
  // For slide: where it comes from.
  @IsOptional() @IsIn(SLIDE_DIRECTIONS as unknown as string[]) direction?: string;
  @IsOptional() @IsInt() @Min(L.entrance.durationMs.min) @Max(L.entrance.durationMs.max) durationMs?: number;
  @IsOptional() @IsInt() @Min(L.entrance.delayMs.min) @Max(L.entrance.delayMs.max) delayMs?: number;
}

// Played over the popup (confetti, snow, ...).
export class EffectDto {
  @IsIn([NO_ANIMATION, ...presetKeys('effect')]) preset!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(L.effect.maxColors) @IsHexColor({ each: true }) colors?: string[];
  @IsOptional() @IsInt() @Min(L.effect.durationMs.min) @Max(L.effect.durationMs.max) durationMs?: number;
}

// Continuous motion while the popup is open.
export class LoopDto {
  @IsIn([NO_ANIMATION, ...presetKeys('loop')]) preset!: string;
  @IsOptional() @IsIn(LOOP_INTENSITIES as unknown as string[]) intensity?: string;
}

// How the uploaded Lottie animation is played (the file itself is uploaded
// with POST /admin/promotions/:id/animation).
export class LottieSettingsDto {
  @IsOptional() @IsBoolean() loop?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(L.lottie.speed.min) @Max(L.lottie.speed.max) speed?: number;
  // hero: in place of the image; background: behind the text; overlay: over everything.
  @IsOptional() @IsIn(LOTTIE_PLACEMENTS as unknown as string[]) placement?: string;
}

export class PromotionThemeDto {
  @IsOptional() @IsHexColor() background?: string;
  @IsOptional() @IsHexColor() textColor?: string;
  @IsOptional() @IsHexColor() accentColor?: string;
  // Read by apps released before Nov 2026. Leave it out and the server fills
  // it in from entrance / effect / loop.
  @IsOptional() @IsIn(LEGACY_ANIMATIONS) animation?: string;
  @IsOptional() @ValidateNested() @Type(() => EntranceDto) entrance?: EntranceDto;
  @IsOptional() @ValidateNested() @Type(() => EffectDto) effect?: EffectDto;
  @IsOptional() @ValidateNested() @Type(() => LoopDto) loop?: LoopDto;
  @IsOptional() @ValidateNested() @Type(() => LottieSettingsDto) lottie?: LottieSettingsDto;
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

export const PROMOTION_EVENTS = ['VIEW', 'CLICK', 'DISMISS'] as const;
export type PromotionEventType = (typeof PROMOTION_EVENTS)[number];

// POST /promotions/:id/events, sent by the app.
export class PromotionEventDto {
  @IsIn(PROMOTION_EVENTS as unknown as string[])
  type!: PromotionEventType;
}
