import { IsLatitude, IsLongitude } from 'class-validator';

export class UpdateRiderLocationDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;
}
