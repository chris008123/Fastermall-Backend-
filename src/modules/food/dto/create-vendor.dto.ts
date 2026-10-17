import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateVendorDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsOptional()
  @IsString()
  location?: string;

  // The VENDOR staff account that may manage this vendor's menu.
  @IsOptional()
  @IsUUID()
  ownerStaffId?: string;
}
