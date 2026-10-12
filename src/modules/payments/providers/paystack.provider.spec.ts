import { createHmac } from 'crypto';
import { PaystackProvider } from './paystack.provider';

const SECRET = 'sk_test_unit_test_secret';
const make = () => new PaystackProvider({ secretKey: SECRET, baseUrl: 'https://api.paystack.test' });
const sign = (body: string) => createHmac('sha512', SECRET).update(body).digest('hex');

describe('PaystackProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('verifyWebhookSignature', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'FM-1' } });

    it('accepts a correctly signed body', () => {
      expect(make().verifyWebhookSignature(Buffer.from(body), sign(body))).toBe(true);
    });

    it('rejects a tampered body', () => {
      expect(make().verifyWebhookSignature(Buffer.from(body + ' '), sign(body))).toBe(false);
    });

    it('rejects a missing or wrong signature', () => {
      expect(make().verifyWebhookSignature(Buffer.from(body), undefined)).toBe(false);
      expect(make().verifyWebhookSignature(Buffer.from(body), 'deadbeef')).toBe(false);
    });

    it('rejects everything when no secret key is configured', () => {
      const p = new PaystackProvider({ secretKey: undefined, baseUrl: 'x' });
      expect(p.verifyWebhookSignature(Buffer.from(body), sign(body))).toBe(false);
    });
  });

  it('parses webhook events', () => {
    expect(make().parseWebhook({ event: 'charge.success', data: { reference: 'R' } })).toEqual({
      type: 'charge.success',
      reference: 'R',
    });
    expect(make().parseWebhook({})).toBeNull();
  });

  it('sends amounts to Paystack in pesewas', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: true, data: { authorization_url: 'https://pay.test/x', reference: 'FM-1' } }),
    } as Response);

    const out = await make().initialize({ reference: 'FM-1', amount: 25.5, currency: 'GHS', email: 'a@b.c' });

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.amount).toBe(2550);
    expect(out.authorizationUrl).toBe('https://pay.test/x');
  });

  it('maps a verified transaction back to major units', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: true, data: { status: 'success', amount: 2550, currency: 'GHS', id: 99 } }),
    } as Response);

    await expect(make().verify('FM-1')).resolves.toEqual({
      status: 'success',
      amount: 25.5,
      currency: 'GHS',
      providerReference: '99',
    });
  });
});
