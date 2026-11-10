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
  const make = (env: Record<string, string>, settings?: any) => new AppConfigService({ get: (k: string) => env[k] } as any, settings);

  it('says whether this app version must update', async () => {
    const svc = make({ APP_MIN_VERSION_PARTNER: '1.5.0', APP_UPDATE_URL_PARTNER: 'https://store/partner' });
    expect((await svc.get('partner', '1.4.9'))).toMatchObject({ minVersion: '1.5.0', updateRequired: true, updateUrl: 'https://store/partner' });
    expect((await svc.get('partner', '1.5.0')).updateRequired).toBe(false);
    expect((await svc.get('partner', '2.0.0')).updateRequired).toBe(false);
  });

  it('never forces an update when no version is sent or no minimum is set', async () => {
    expect((await make({ APP_MIN_VERSION_PARTNER: '1.5.0' }).get('partner')).updateRequired).toBe(false);
    expect((await make({}).get('partner', '0.0.1'))).toMatchObject({ minVersion: null, updateRequired: false });
  });

  it('keeps the partner and customer minimums apart', async () => {
    const svc = make({ APP_MIN_VERSION_PARTNER: '2.0.0', APP_MIN_VERSION_CUSTOMER: '1.0.0' });
    expect((await svc.get('customer', '1.2.0')).updateRequired).toBe(false);
    expect((await svc.get('partner', '1.2.0')).updateRequired).toBe(true);
  });

  it('reports maintenance, support contacts and legal links', async () => {
    const svc = make({ MAINTENANCE_MODE: 'true', MAINTENANCE_MESSAGE: 'Back at 6pm', SUPPORT_PHONE: '0241234567', PRIVACY_URL: 'https://fastermall.com/privacy' });
    const cfg = await svc.get('partner');
    expect(cfg.maintenance).toEqual({ enabled: true, message: 'Back at 6pm' });
    expect(cfg.support).toEqual({ phone: '0241234567', email: null, whatsapp: null, whatsappUrl: null });
    expect(cfg.legal).toEqual({ privacyUrl: 'https://fastermall.com/privacy', termsUrl: null });
    expect((await make({}).get('partner')).maintenance).toMatchObject({ enabled: false });
  });

  it("follows the admin maintenance switch, with the admin's message", async () => {
    const settings = { getAll: jest.fn().mockResolvedValue({ maintenanceMode: true, maintenanceMessage: 'Stock-taking until 2pm' }) };
    expect((await make({}, settings).get('customer')).maintenance).toEqual({ enabled: true, message: 'Stock-taking until 2pm' });
    settings.getAll.mockResolvedValue({ maintenanceMode: false, maintenanceMessage: 'x' });
    expect((await make({}, settings).get('customer')).maintenance.enabled).toBe(false);
  });

  it('includes the WhatsApp contact from the admin setting', async () => {
    const settings = { getAll: jest.fn().mockResolvedValue({ maintenanceMode: false, maintenanceMessage: '', whatsappContactNumber: '233241234567' }) };
    expect((await make({}, settings).get('customer')).support).toMatchObject({
      whatsapp: '233241234567',
      whatsappUrl: 'https://wa.me/233241234567',
    });
  });
});
