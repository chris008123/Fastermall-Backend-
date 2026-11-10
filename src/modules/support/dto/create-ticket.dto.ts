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

  // Optional, for "Report a problem": what is being reported (e.g. ORDER,
  // LISTING, VENDOR), its id, and the reason picked in the app. Stored as
  // given so admins can filter and count reports.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reason?: string;
}
