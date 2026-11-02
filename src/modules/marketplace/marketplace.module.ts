import { Module } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  controllers: [MarketplaceController, ReviewsController],
  providers: [MarketplaceService, ReviewsService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
