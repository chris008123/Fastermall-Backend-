import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangeStaffPasswordDto {
  @IsString()
  @MaxLength(72)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword: string;
}
