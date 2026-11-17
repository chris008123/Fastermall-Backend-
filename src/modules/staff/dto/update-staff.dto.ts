import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

  // The acting admin's own password. Required to change an admin account's
  // sign-in email (see StaffService.assertCanChangeCredentials).
  @IsOptional()
  @IsString()
  @MaxLength(72)
  currentPassword?: string;
}
