import { IsEmail, IsString } from 'class-validator';

export class LoginStaffDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
