import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { FoodModule } from '../food/food.module';
import { AddressesModule } from '../addresses/addresses.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [MarketplaceModule, FoodModule, AddressesModule, PaymentsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
