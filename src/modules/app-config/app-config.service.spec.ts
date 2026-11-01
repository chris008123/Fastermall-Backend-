import { AppConfigService, compareVersions } from './app-config.service';

describe('compareVersions', () => {
  it.each([
    ['1.10.0', '1.9.9', 1],
    ['1.2', '1.2.0', 0],
    ['2.0.0', '10.0.0', -1],
    ['1.4.2-beta.1', '1.4.2', 0],
    ['abc', '0.0.1', -1],
  ])('%s vs %s', (a, b, expected) => expect(compareVersions(a, b)).toBe(expected));
});

describe('AppConfigService', () => {
  const make = (env: Record<string, string>) => new AppConfigService({ get: (k: string) => env[k] } as any);

  it('says whether this app version must update', () => {
    const svc = make({ APP_MIN_VERSION_PARTNER: '1.5.0', APP_UPDATE_URL_PARTNER: 'https://store/partner' });
    expect(svc.get('partner', '1.4.9')).toMatchObject({ minVersion: '1.5.0', updateRequired: true, updateUrl: 'https://store/partner' });
    expect(svc.get('partner', '1.5.0').updateRequired).toBe(false);
    expect(svc.get('partner', '2.0.0').updateRequired).toBe(false);
  });

  it('never forces an update when no version is sent or no minimum is set', () => {
    expect(make({ APP_MIN_VERSION_PARTNER: '1.5.0' }).get('partner').updateRequired).toBe(false);
    expect(make({}).get('partner', '0.0.1')).toMatchObject({ minVersion: null, updateRequired: false });
  });

  it('keeps the partner and customer minimums apart', () => {
    const svc = make({ APP_MIN_VERSION_PARTNER: '2.0.0', APP_MIN_VERSION_CUSTOMER: '1.0.0' });
    expect(svc.get('customer', '1.2.0').updateRequired).toBe(false);
    expect(svc.get('partner', '1.2.0').updateRequired).toBe(true);
  });

  it('reports maintenance, support contacts and legal links', () => {
    const svc = make({ MAINTENANCE_MODE: 'true', MAINTENANCE_MESSAGE: 'Back at 6pm', SUPPORT_PHONE: '0241234567', PRIVACY_URL: 'https://fastermall.com/privacy' });
    const cfg = svc.get('partner');
    expect(cfg.maintenance).toEqual({ enabled: true, message: 'Back at 6pm' });
    expect(cfg.support).toEqual({ phone: '0241234567', email: null });
    expect(cfg.legal).toEqual({ privacyUrl: 'https://fastermall.com/privacy', termsUrl: null });
    expect(make({}).get('partner').maintenance).toMatchObject({ enabled: false });
  });
});
