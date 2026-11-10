import { Module } from '@nestjs/common';
import { AdminPromotionsController, PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageService } from '../../shared/storage/storage.service';

@Module({
  imports: [NotificationsModule],
  controllers: [PromotionsController, AdminPromotionsController],
  providers: [PromotionsService, StorageService],
})
export class PromotionsModule {}
