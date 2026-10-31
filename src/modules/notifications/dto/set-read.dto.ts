import { IsBoolean } from 'class-validator';

export class SetReadDto {
  @IsBoolean()
  isRead: boolean;
}
