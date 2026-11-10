import { IsInt, Max, Min } from 'class-validator';

export class CashOutDto {
  // Whole pesewas (GHS 25.50 is 2550). Never a decimal.
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountPesewas: number;
}
