import configuration from './configuration';

describe('configuration: orders.paymentTimeoutMinutes', () => {
  const original = process.env.ORDER_PAYMENT_TIMEOUT_MINUTES;
  afterEach(() => {
    if (original === undefined) delete process.env.ORDER_PAYMENT_TIMEOUT_MINUTES;
    else process.env.ORDER_PAYMENT_TIMEOUT_MINUTES = original;
  });

  it('defaults to 30 minutes', () => {
    delete process.env.ORDER_PAYMENT_TIMEOUT_MINUTES;
    expect(configuration().orders.paymentTimeoutMinutes).toBe(30);
  });

  it('reads ORDER_PAYMENT_TIMEOUT_MINUTES', () => {
    process.env.ORDER_PAYMENT_TIMEOUT_MINUTES = '45';
    expect(configuration().orders.paymentTimeoutMinutes).toBe(45);
  });

  it.each(['0', '-5', 'abc', ''])('falls back to 30 for %p', (value) => {
    process.env.ORDER_PAYMENT_TIMEOUT_MINUTES = value;
    expect(configuration().orders.paymentTimeoutMinutes).toBe(30);
  });
});
