import { IsString, MinLength } from 'class-validator';

export class BootstrapAdminDto {
  @IsString()
  secret: string;

  @IsString()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  fullName: string;
}
