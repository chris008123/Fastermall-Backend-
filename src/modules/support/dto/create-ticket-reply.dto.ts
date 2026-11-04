import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTicketReplyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message: string;
}
