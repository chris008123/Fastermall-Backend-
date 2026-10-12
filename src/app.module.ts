import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
import configuration from './config/configuration';
import { PrismaModule } from './database/prisma.module';

import { IdentityModule } from './modules/identity/identity.module';
import { StaffModule } from './modules/staff/staff.module';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { FoodModule } from './modules/food/food.module';
import { LaundryModule } from './modules/laundry/laundry.module';
import { OrdersModule } from './modules/orders/orders.module';
import { LogisticsModule } from './modules/logistics/logistics.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SupportModule } from './modules/support/support.module';
import { AdminModule } from './modules/admin/admin.module';
import { EmailModule } from './shared/email/email.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
    EventEmitterModule.forRoot(),
    PrismaModule,

    IdentityModule, // customer-facing app
    StaffModule,    // staff-facing app: vendors, delivery partners, laundry staff, admins
    MarketplaceModule,
    FoodModule,
    LaundryModule,
    OrdersModule,
    LogisticsModule,
    PaymentsModule,
    NotificationsModule,
    SupportModule,
    AdminModule,
    EmailModule,
  ],
  providers: [
    // Without this guard the throttler is configured but never enforced.
    // Sensitive routes (login, OTP, reset) add stricter @Throttle limits.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
