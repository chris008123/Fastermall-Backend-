import { Module } from '@nestjs/common';
import { AdminPartnerApplicationsController, PartnerApplicationsController } from './partner-applications.controller';
import { PartnerApplicationsService } from './partner-applications.service';

@Module({
  controllers: [PartnerApplicationsController, AdminPartnerApplicationsController],
  providers: [PartnerApplicationsService],
})
export class PartnerApplicationsModule {}
