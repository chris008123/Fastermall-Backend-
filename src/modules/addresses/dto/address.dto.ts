import { PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAddressDto {
  // What the customer calls it, e.g. "Hostel" or "Lecture block".
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  label: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  hostel: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  room: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  landmark?: string;

  // Send both or neither.
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto extends PartialType(CreateAddressDto) {}
