import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { BROADCAST_AUDIENCES, BroadcastAudience } from '../../notifications/notifications.service';

export class BroadcastDto {
  @IsIn(BROADCAST_AUDIENCES as unknown as string[])
  audience: BroadcastAudience;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body: string;
}
