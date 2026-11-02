import { Module } from '@nestjs/common';
import { LaundryController } from './laundry.controller';
import { LaundryService } from './laundry.service';
import { AddressesModule } from '../addresses/addresses.module';

@Module({
  imports: [AddressesModule],
  controllers: [LaundryController],
  providers: [LaundryService],
  exports: [LaundryService],
})
export class LaundryModule {}
