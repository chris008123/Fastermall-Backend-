import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DeliveryPartnerType } from '@prisma/client';

// PATCH /logistics/me. Send only what changes.
export class UpdatePartnerStatusDto {
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  // Letters, numbers, spaces and dashes, e.g. GR-1234-20. Stored in capitals.
  @IsOptional()
  @IsString()
  @MaxLength(15)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 -]{2,14}$/, { message: 'vehiclePlate must be 3 to 15 letters, numbers, spaces or dashes' })
  vehiclePlate?: string;

  @IsOptional()
  @IsEnum(DeliveryPartnerType)
  vehicleType?: DeliveryPartnerType;

  @IsOptional()
  @Matches(/^0\d{9}$/, { message: 'phone must be 10 digits starting with 0' })
  phone?: string;

  // Needed when changing the phone number.
  @IsOptional()
  @IsString()
  @MaxLength(72)
  currentPassword?: string;
}
