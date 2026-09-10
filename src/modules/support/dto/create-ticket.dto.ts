import { IsString, MinLength } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  @MinLength(3)
  subject: string;

  @IsString()
  @MinLength(5)
  message: string;
}
