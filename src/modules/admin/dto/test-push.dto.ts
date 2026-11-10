import { IsOptional, IsString, MaxLength } from 'class-validator';

// Exactly one of the two: a customer (userId) or a staff member (staffUserId).
export class TestPushDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  staffUserId?: string;
}
