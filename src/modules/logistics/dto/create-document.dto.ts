import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsIn, IsOptional, Max, Min } from 'class-validator';
import { DocumentType } from '@prisma/client';

export const DOCUMENT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

export class CreateDocumentDto {
  @IsEnum(DocumentType)
  type: DocumentType;

  @IsIn(DOCUMENT_CONTENT_TYPES)
  contentType: (typeof DOCUMENT_CONTENT_TYPES)[number];

  // The size the app is about to upload. Checked again against the real file.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50 * 1024 * 1024)
  sizeBytes: number;

  // Licences and insurance expire. ISO date, e.g. 2027-03-31.
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
