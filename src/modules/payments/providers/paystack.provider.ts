import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  InitializeInput,
  InitializeResult,
  PaymentProvider,
  VerifyResult,
  WebhookEvent,
} from './payment-provider.interface';

interface PaystackConfig {
  secretKey?: string;
  baseUrl: string;
}

const toMinor = (amount: number) => Math.round(amount * 100);
const fromMinor = (amount: number) => amount / 100;

@Injectable()
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';
  private readonly logger = new Logger('PaystackProvider');

  constructor(private readonly cfg: PaystackConfig) {}

  private get secret(): string {
    if (!this.cfg.secretKey) {
      throw new BadGatewayException('Payments are not configured (PAYSTACK_SECRET_KEY missing)');
    }
    return this.cfg.secretKey;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.logger.error(`Paystack request failed: ${(e as Error).message}`);
      throw new BadGatewayException('Could not reach the payment provider. Please try again.');
    }

    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.status) {
      this.logger.error(`Paystack error ${res.status}: ${json?.message ?? 'unknown'}`);
      throw new BadGatewayException('The payment provider rejected the request.');
    }
    return json as T;
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const json = await this.call<any>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        amount: toMinor(input.amount),
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        channels: input.channels,
        metadata: input.metadata,
      }),
    });

    return {
      authorizationUrl: json.data.authorization_url,
      reference: json.data.reference ?? input.reference,
    };
  }

  async verify(reference: string): Promise<VerifyResult> {
    const json = await this.call<any>(`/transaction/verify/${encodeURIComponent(reference)}`);
    const d = json.data;

    let status: VerifyResult['status'] = 'pending';
    if (d.status === 'success') status = 'success';
    else if (['failed', 'abandoned', 'reversed'].includes(d.status)) status = 'failed';

    return {
      status,
      amount: fromMinor(Number(d.amount)),
      currency: String(d.currency),
      providerReference: d.id !== undefined ? String(d.id) : undefined,
    };
  }

  // Paystack signs the raw request body with HMAC-SHA512 using the secret key
  // and sends it in the x-paystack-signature header.
  verifyWebhookSignature(rawBody: Buffer | string | undefined, signature: string | undefined): boolean {
    if (!rawBody || !signature || !this.cfg.secretKey) return false;

    const expected = createHmac('sha512', this.cfg.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(body: any): WebhookEvent | null {
    if (!body || typeof body.event !== 'string') return null;
    return { type: body.event, reference: body?.data?.reference };
  }
}
