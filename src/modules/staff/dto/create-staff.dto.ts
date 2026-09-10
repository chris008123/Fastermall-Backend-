import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { StaffRole, DeliveryPartnerType } from '@prisma/client';

export class CreateStaffDto {
  @IsString()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsEnum(StaffRole)
  role: StaffRole;

  // Only used when role === DELIVERY_PARTNER — creates their partner profile too
  @IsOptional()
  @IsEnum(DeliveryPartnerType)
  partnerType?: DeliveryPartnerType;
}
