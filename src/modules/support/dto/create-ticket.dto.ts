import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  subject: string;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  message: string;

  // The delivery this is about. Must be one of your own.
  @IsOptional()
  @IsUUID()
  deliveryId?: string;
}
