import { IsBoolean, IsNumber, IsOptional } from 'class-validator';

export class UpdatePartnerStatusDto {
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsNumber()
  currentLat?: number;

  @IsOptional()
  @IsNumber()
  currentLng?: number;
}
