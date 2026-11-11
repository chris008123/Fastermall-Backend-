import { Module } from '@nestjs/common';
import { AdminPreOrdersController, PreOrdersController } from './preorders.controller';
import { PreOrdersService } from './preorders.service';
import { StorageService } from '../../shared/storage/storage.service';

@Module({
  controllers: [PreOrdersController, AdminPreOrdersController],
  providers: [PreOrdersService, StorageService],
})
export class PreOrdersModule {}
