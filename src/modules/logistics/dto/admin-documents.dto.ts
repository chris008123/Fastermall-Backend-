import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DocumentStatus } from '@prisma/client';

export class AdminDocumentsQueryDto {
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ReviewDocumentDto {
  @IsIn(['APPROVED', 'REJECTED'])
  status: 'APPROVED' | 'REJECTED';

  // Required when rejecting: the partner sees it.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  rejectionReason?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
