import { IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Any subset of the settings. SettingsService validates again (2 decimals).
export class UpdateSettingsDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  marketplaceDeliveryFee?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  laundryPickupFee?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  partnerEarningPerDelivery?: number;

  @IsOptional() @IsBoolean()
  maintenanceMode?: boolean;

  @IsOptional() @IsString() @MaxLength(300)
  maintenanceMessage?: string;

  // "Contact us" WhatsApp number. Any common format; stored as 233XXXXXXXXX.
  // An empty string removes it.
  @IsOptional() @IsString() @MaxLength(30)
  whatsappContactNumber?: string;
}
