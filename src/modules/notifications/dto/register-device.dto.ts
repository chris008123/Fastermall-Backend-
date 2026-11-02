import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// Per-category push switches. A missing field leaves the stored value alone.
export class DevicePreferencesDto {
  @IsOptional()
  @IsBoolean()
  orderUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  announcements?: boolean;
}

export class RegisterDeviceDto {
  // Expo push token, e.g. ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  token!: string;

  @IsOptional()
  @IsIn(['ios', 'android', 'web'])
  platform?: 'ios' | 'android' | 'web';

  // Sent by the app when Expo rotates the token, so the old one is removed.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  previousToken?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DevicePreferencesDto)
  preferences?: DevicePreferencesDto;
}
