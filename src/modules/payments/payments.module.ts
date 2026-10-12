import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';
import { PaystackProvider } from './providers/paystack.provider';
import { MockProvider } from './providers/mock.provider';

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      // Switch gateways by changing PAYMENT_PROVIDER (and adding a class that
      // implements PaymentProvider). Nothing else in the app has to change.
      useFactory: (config: ConfigService): PaymentProvider => {
        const name = (config.get<string>('payments.provider') ?? 'paystack').toLowerCase();

        if (name === 'mock') {
          if (process.env.NODE_ENV === 'production') {
            throw new Error('PAYMENT_PROVIDER=mock is not allowed in production');
          }
          return new MockProvider();
        }

        if (name === 'paystack') {
          return new PaystackProvider({
            secretKey: config.get<string>('payments.paystack.secretKey'),
            baseUrl: config.get<string>('payments.paystack.baseUrl') ?? 'https://api.paystack.co',
          });
        }

        throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`);
      },
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
