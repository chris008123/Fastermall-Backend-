import { EmailService } from './email.service';

describe('EmailService.sendPartnerApprovedEmail', () => {
  const make = () => {
    const service = new EmailService({ get: (k: string) => (k === 'email.from' ? 'Fastermall <hello@fastermall.app>' : undefined) } as never);
    const sendMail = jest.fn().mockResolvedValue({});
    (service as unknown as { transporter: { sendMail: jest.Mock } }).transporter = { sendMail };
    return { service, sendMail };
  };

  it('includes the sign-in email, the setup code, how long it lasts and what to upload', async () => {
    const { service, sendMail } = make();
    await service.sendPartnerApprovedEmail('kojo@example.com', { fullName: 'Kojo Mensah', code: '482913', validDays: 7, motorcycle: true });
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('kojo@example.com');
    expect(mail.subject).toMatch(/approved/);
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('kojo@example.com');
      expect(part).toContain('482913');
      expect(part).toMatch(/7 days/);
      expect(part).toMatch(/insurance/);
      expect(part).not.toMatch(/password:/i);
    }
    expect(mail.text).toMatch(/^Hi Kojo,/);
  });

  it('escapes names so they cannot inject HTML', async () => {
    const { service, sendMail } = make();
    await service.sendPartnerApprovedEmail('a@b.co', { fullName: '<img src=x onerror=alert(1)> Smith', code: '<b>1</b>', validDays: 7, motorcycle: false });
    const { html } = sendMail.mock.calls[0][0];
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;b&gt;1&lt;/b&gt;');
    expect(html).not.toMatch(/insurance/);
  });
});
