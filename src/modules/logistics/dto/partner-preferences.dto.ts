import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class NotificationPrefsDto {
  @IsOptional() @IsBoolean() newJobs?: boolean;
  @IsOptional() @IsBoolean() jobUpdates?: boolean;
  @IsOptional() @IsBoolean() payments?: boolean;
  @IsOptional() @IsBoolean() promotions?: boolean;
  @IsOptional() @IsBoolean() sound?: boolean;
  @IsOptional() @IsBoolean() vibration?: boolean;
}

export class DeliveryPrefsDto {
  @IsOptional() @IsBoolean() autoAccept?: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(50) pickupRadiusKm?: number;

  @IsOptional() @IsInt() @Min(1) @Max(100) maxDistanceKm?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  jobTypes?: string[];
}

export class NavigationPrefsDto {
  @IsOptional() @IsString() @MaxLength(20) preferredMapApp?: string;
  @IsOptional() @IsBoolean() avoidTolls?: boolean;
  @IsOptional() @IsBoolean() avoidHighways?: boolean;
}

// Send only the sections / keys that changed; the rest keep their saved value.
export class PartnerPreferencesDto {
  @IsOptional() @ValidateNested() @Type(() => NotificationPrefsDto) notifications?: NotificationPrefsDto;
  @IsOptional() @ValidateNested() @Type(() => DeliveryPrefsDto) delivery?: DeliveryPrefsDto;
  @IsOptional() @ValidateNested() @Type(() => NavigationPrefsDto) navigation?: NavigationPrefsDto;
}
