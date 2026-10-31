import { Module } from '@nestjs/common';
import { LogisticsController } from './logistics.controller';
import { LogisticsService } from './logistics.service';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { StaffModule } from '../staff/staff.module';

@Module({
  imports: [StaffModule],
  controllers: [LogisticsController, WalletController],
  providers: [LogisticsService, WalletService],
  exports: [LogisticsService],
})
export class LogisticsModule {}
