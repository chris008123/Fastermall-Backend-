import { Module } from '@nestjs/common';
import { AdminLegalController, LegalController } from './legal.controller';
import { LegalService } from './legal.service';

@Module({
  controllers: [LegalController, AdminLegalController],
  providers: [LegalService],
})
export class LegalModule {}
