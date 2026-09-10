import { IsNumber, IsString, Min, MinLength } from 'class-validator';

export class CreateMenuItemDto {
  @IsString()
  vendorId: string;

  @IsString()
  @MinLength(2)
  name: string;

  @IsNumber()
  @Min(0)
  price: number;
}
