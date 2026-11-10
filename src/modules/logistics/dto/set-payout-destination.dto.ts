import { IsIn, IsString, Matches, MaxLength } from 'class-validator';

export const PAYOUT_NETWORKS = ['MTN', 'TELECEL', 'AIRTELTIGO'] as const;

export class SetPayoutDestinationDto {
  @IsIn(PAYOUT_NETWORKS)
  network: (typeof PAYOUT_NETWORKS)[number];

  @Matches(/^0\d{9}$/, { message: 'number must be 10 digits starting with 0' })
  number: string;

  @IsString()
  @MaxLength(72)
  password: string;
}
