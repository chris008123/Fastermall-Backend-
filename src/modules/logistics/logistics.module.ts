import { Module } from '@nestjs/common';
import { LogisticsController } from './logistics.controller';
import { LogisticsService } from './logistics.service';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { StorageService } from '../../shared/storage/storage.service';
import { ProfileService } from './profile.service';
import { PresenceService } from './presence.service';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { StaffModule } from '../staff/staff.module';

@Module({
  imports: [StaffModule],
  controllers: [LogisticsController, WalletController, PreferencesController, DocumentsController],
  providers: [LogisticsService, WalletService, PreferencesService, PresenceService, DocumentsService, StorageService, ProfileService],
  exports: [LogisticsService],
})
export class LogisticsModule {}
