import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class ResetStaffPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6)
  code: string;

  // bcrypt only reads the first 72 bytes, so longer passwords are refused.
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword: string;
}
