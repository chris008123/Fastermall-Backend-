import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class LaundryOrderItemDto {
  @IsUUID()
  catalogItemId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateLaundryOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LaundryOrderItemDto)
  items: LaundryOrderItemDto[];

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsString()
  pickupMode?: string;

  @IsOptional()
  @IsDateString()
  pickupAt?: string;

  @IsOptional()
  @IsDateString()
  deliverAt?: string;

  @IsOptional()
  @IsString()
  estimatedKg?: string;
}
