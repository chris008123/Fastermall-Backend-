import { securityHeaders } from './security-headers';

function run(isProd: boolean) {
  const headers: Record<string, string> = {};
  const res: any = { setHeader: (k: string, v: string) => (headers[k] = v) };
  const next = jest.fn();
  securityHeaders(isProd)({} as any, res, next);
  return { headers, next };
}

describe('securityHeaders', () => {
  it('sets the basic headers and continues', () => {
    const { headers, next } = run(false);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Strict-Transport-Security']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('adds HSTS only in production', () => {
    expect(run(true).headers['Strict-Transport-Security']).toMatch(/max-age=/);
  });
});
