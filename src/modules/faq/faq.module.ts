import { Module } from '@nestjs/common';
import { AdminFaqController, FaqController } from './faq.controller';
import { FaqService } from './faq.service';

@Module({
  controllers: [FaqController, AdminFaqController],
  providers: [FaqService],
})
export class FaqModule {}
