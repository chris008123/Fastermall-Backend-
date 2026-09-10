import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { FoodModule } from '../food/food.module';

@Module({
  imports: [MarketplaceModule, FoodModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
