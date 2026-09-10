import { Module } from '@nestjs/common';
import { LaundryController } from './laundry.controller';
import { LaundryService } from './laundry.service';

@Module({
  controllers: [LaundryController],
  providers: [LaundryService],
  exports: [LaundryService],
})
export class LaundryModule {}
