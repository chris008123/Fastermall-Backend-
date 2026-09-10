import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
import configuration from './config/configuration';
import { PrismaModule } from './database/prisma.module';

import { IdentityModule } from './modules/identity/identity.module';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { FoodModule } from './modules/food/food.module';
import { LaundryModule } from './modules/laundry/laundry.module';
import { OrdersModule } from './modules/orders/orders.module';
import { LogisticsModule } from './modules/logistics/logistics.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SupportModule } from './modules/support/support.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),

    // Rate limiter — first line of the security middleware pipeline
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),

    // Domain Event Bus — modules publish/subscribe instead of calling
    // each other directly (e.g. Order Created -> Payment, Logistics, Notification)
    EventEmitterModule.forRoot(),

    PrismaModule,

    // Business domain modules — each owns its own logic, models, and endpoints
    IdentityModule,
    MarketplaceModule,
    FoodModule,
    LaundryModule,
    OrdersModule,
    LogisticsModule,
    PaymentsModule,
    NotificationsModule,
    SupportModule,
    AdminModule,
  ],
})
export class AppModule {}
