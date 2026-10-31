import { Module } from '@nestjs/common';
import { LogisticsController } from './logistics.controller';
import { LogisticsService } from './logistics.service';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { PresenceService } from './presence.service';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { StaffModule } from '../staff/staff.module';

@Module({
  imports: [StaffModule],
  controllers: [LogisticsController, WalletController, PreferencesController],
  providers: [LogisticsService, WalletService, PreferencesService, PresenceService],
  exports: [LogisticsService],
})
export class LogisticsModule {}
