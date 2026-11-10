import { Module } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { ProductImagesController } from './product-images.controller';
import { ProductImagesService } from './product-images.service';
import { StorageService } from '../../shared/storage/storage.service';

@Module({
  controllers: [MarketplaceController, ReviewsController, ProductImagesController],
  providers: [MarketplaceService, ReviewsService, ProductImagesService, StorageService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
