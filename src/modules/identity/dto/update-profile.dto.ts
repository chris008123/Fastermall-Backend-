import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  fullName?: string;

  // Local 10-digit Ghana number, e.g. 0241234567.
  @IsOptional()
  @Matches(/^0\d{9}$/, { message: 'phone must be a 10-digit number starting with 0' })
  phone?: string;
}
