import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

// Admin edit of a staff account's contact details. Role changes aren't
// supported: a partner's delivery profile and history depend on the role.
export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  fullName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}
