import { IsEmail } from 'class-validator';

export class ForgotStaffPasswordDto {
  @IsEmail()
  email: string;
}
