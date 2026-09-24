import { IsBoolean, IsOptional } from 'class-validator';

export class UpdatePartnerStatusDto {
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}