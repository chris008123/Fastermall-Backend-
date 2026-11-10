import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReplyTicketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body: string;
}
