// Every payment gateway (Paystack today, anything else tomorrow) implements
// this small contract. PaymentsService only ever talks to this interface, so
// switching providers means adding one class and changing PAYMENT_PROVIDER.

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export type PaymentChannel = 'card' | 'mobile_money';

export interface InitializeInput {
  reference: string;
  /** Amount in the currency's major unit (e.g. 25.50 GHS). Converted to minor units by the provider. */
  amount: number;
  currency: string;
  email: string;
  callbackUrl?: string;
  channels?: PaymentChannel[];
  metadata?: Record<string, unknown>;
}

export interface InitializeResult {
  authorizationUrl: string;
  reference: string;
}

export type ProviderPaymentStatus = 'success' | 'failed' | 'pending';

export interface VerifyResult {
  status: ProviderPaymentStatus;
  /** Amount in the currency's major unit. */
  amount: number;
  currency: string;
  providerReference?: string;
}

export interface WebhookEvent {
  type: string;
  reference?: string;
}

export interface PaymentProvider {
  readonly name: string;
  initialize(input: InitializeInput): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifyResult>;
  verifyWebhookSignature(rawBody: Buffer | string | undefined, signature: string | undefined): boolean;
  parseWebhook(body: any): WebhookEvent | null;
}
