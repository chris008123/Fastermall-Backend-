import { Module } from '@nestjs/common';
import { LaundryController } from './laundry.controller';
import { LaundryService } from './laundry.service';
import { AddressesModule } from '../addresses/addresses.module';
import { AdminLaundryVendorsController, LaundryVendorsController } from './laundry-vendors.controller';
import { LaundryVendorsService } from './laundry-vendors.service';

@Module({
  imports: [AddressesModule],
  controllers: [LaundryController, LaundryVendorsController, AdminLaundryVendorsController],
  providers: [LaundryService, LaundryVendorsService],
  exports: [LaundryService],
})
export class LaundryModule {}
