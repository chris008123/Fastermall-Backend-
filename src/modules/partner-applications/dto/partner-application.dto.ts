import { Transform } from 'class-transformer';
import { DeliveryPartnerType, PartnerApplicationStatus } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/**
 * "+233 24 123 4567", "233241234567" and "024 123 4567" all become
 * "0241234567", the form staff phone numbers are stored in.
 */
export function normalizeGhanaPhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const digits = value.replace(/\D/g, '');
  if (/^233\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  return digits;
}

export class CreatePartnerApplicationDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  fullName!: string;

  // Becomes the partner's sign-in email once approved.
  @Transform(lower)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(200)
  email!: string;

  @Transform(({ value }) => normalizeGhanaPhone(value))
  @Matches(/^0\d{9}$/, { message: 'Enter a 10-digit Ghana phone number, e.g. 0241234567' })
  phone!: string;

  // YYYY-MM-DD. Applicants must be 18 or older (checked in the service).
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date of birth must look like 2001-05-14' })
  dateOfBirth!: string;

  @Transform(trim)
  @IsString()
  @MinLength(4)
  @MaxLength(200)
  address!: string;

  @IsEnum(DeliveryPartnerType)
  partnerType!: DeliveryPartnerType;

  // Required for motorcycle partners.
  @ValidateIf((o: CreatePartnerApplicationDto) => o.partnerType === DeliveryPartnerType.MOTORCYCLE)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  plateNumber?: string;
}

export class PartnerApplicationQueryDto {
  @IsOptional()
  @IsEnum(PartnerApplicationStatus)
  status?: PartnerApplicationStatus;
}

export class ApprovePartnerApplicationDto {
  // Deprecated and ignored: older consoles sent a temporary password. The
  // partner now sets their own with the emailed setup code. Kept so those
  // requests aren't refused for an unknown field.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  password?: string;
}

export class RejectPartnerApplicationDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
