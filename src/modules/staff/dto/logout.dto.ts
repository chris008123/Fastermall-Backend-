import { IsOptional, IsString, MaxLength } from 'class-validator';

export class LogoutDto {
  // This phone's Expo push token. Removing it here means a signed-out phone
  // stops getting the account's pushes even if the app forgets to say so.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  pushToken?: string;
}
