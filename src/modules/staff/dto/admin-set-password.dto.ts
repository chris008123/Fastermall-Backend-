import { IsString, MaxLength, MinLength } from 'class-validator';

// Admin sets a new password for a staff member (PATCH /staff/users/:id/password).
export class AdminSetStaffPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
