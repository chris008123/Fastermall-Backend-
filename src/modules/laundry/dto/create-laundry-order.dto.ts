import { IsArray, IsDateString, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateLaundryOrderDto {
  @IsString()
  servicePackage: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsDateString()
  pickupAt?: string;

  // Simple description strings for each garment, e.g. ["2 shirts", "1 jacket"]
  @IsArray()
  @IsString({ each: true })
  items: string[];
}
