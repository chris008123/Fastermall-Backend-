import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterDeviceDto {
  // Expo push token, e.g. ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  token!: string;

  @IsOptional()
  @IsIn(['ios', 'android', 'web'])
  platform?: 'ios' | 'android' | 'web';

  // Sent by the app when Expo rotates the token, so the old one is removed.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  previousToken?: string;
}
