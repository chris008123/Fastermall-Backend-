import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Admin sets a new password for a staff member (PATCH /staff/users/:id/password).
export class AdminSetStaffPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  // The acting admin's own password. Required to set a new password on an
  // admin account (see StaffService.assertCanChangeCredentials).
  @IsOptional()
  @IsString()
  @MaxLength(72)
  currentPassword?: string;
}
