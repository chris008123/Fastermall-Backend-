import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateLegalPageDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title?: string;

  // Markdown: headings (##), lists, tables, links.
  @IsString()
  @MinLength(50, { message: 'The page text must be at least 50 characters' })
  @MaxLength(100_000)
  content!: string;
}
