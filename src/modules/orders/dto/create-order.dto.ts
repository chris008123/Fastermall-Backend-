import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  Max,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderType } from '@prisma/client';

export class OrderItemInput {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  menuItemId?: string;

  @IsInt()
  @Min(1)
  @Max(100)
  quantity: number;
}

export class CreateOrderDto {
  @IsEnum(OrderType)
  type: OrderType;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInput)
  items: OrderItemInput[];

  @IsOptional()
  @IsString()
  vendorName?: string;

  @IsOptional()
  @IsString()
  addressLabel?: string;

  /**
   * @deprecated Ignored. The delivery fee is set by the server from the
   * vendor. Kept only so older app versions that still send it are not
   * rejected by the whitelist validation.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  deliveryFee?: number;

  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
