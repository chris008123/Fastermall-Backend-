import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateProductDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsString()
  categoryId?: string;

  // Customers may request it made to order (POST /preorders).
  @IsOptional()
  @IsBoolean()
  allowsPreOrder?: boolean;

  // Usual days from an accepted quote to delivery, shown in the app.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  preOrderLeadDays?: number;
}
