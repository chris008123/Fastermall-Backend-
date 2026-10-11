import { Injectable } from '@nestjs/common';
import {
  InitializeInput,
  InitializeResult,
  PaymentProvider,
  VerifyResult,
  WebhookEvent,
} from './payment-provider.interface';

// Local development / tests only — PaymentsModule refuses to use this in
// production. Every payment "succeeds" for the amount it was initialised with.
@Injectable()
export class MockProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly seen = new Map<string, { amount: number; currency: string }>();

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    this.seen.set(input.reference, { amount: input.amount, currency: input.currency });
    return {
      authorizationUrl: input.callbackUrl ?? 'https://example.com/mock-payment',
      reference: input.reference,
    };
  }

  async verify(reference: string): Promise<VerifyResult> {
    const known = this.seen.get(reference);
    if (!known) return { status: 'failed', amount: 0, currency: 'GHS' };
    return { status: 'success', ...known, providerReference: `MOCK-${reference}` };
  }

  verifyWebhookSignature(): boolean {
    return false; // the mock provider has no webhooks
  }

  parseWebhook(): WebhookEvent | null {
    return null;
  }
}
