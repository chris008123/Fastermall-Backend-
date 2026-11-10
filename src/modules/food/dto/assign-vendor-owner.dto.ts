import { IsUUID } from 'class-validator';

export class AssignVendorOwnerDto {
  @IsUUID()
  ownerStaffId: string;
}
