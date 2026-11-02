import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  @MinLength(3)
  subject: string;

  @IsString()
  @MinLength(5)
  message: string;

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
