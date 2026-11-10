import { IsString, MaxLength } from 'class-validator';

export class ConfirmPasswordDto {
  @IsString()
  @MaxLength(72)
  password: string;
}
