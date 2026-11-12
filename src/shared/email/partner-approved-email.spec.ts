import { EmailService } from './email.service';

describe('EmailService.sendPartnerApprovedEmail', () => {
  const make = () => {
    const service = new EmailService({ get: (k: string) => (k === 'email.from' ? 'Fastermall <hello@fastermall.app>' : undefined) } as never);
    const sendMail = jest.fn().mockResolvedValue({});
    (service as unknown as { transporter: { sendMail: jest.Mock } }).transporter = { sendMail };
    return { service, sendMail };
  };

  it('includes the sign-in email, the temporary password and what to upload', async () => {
    const { service, sendMail } = make();
    await service.sendPartnerApprovedEmail('kojo@example.com', { fullName: 'Kojo Mensah', password: 'Ab3dEf6hJk9m', motorcycle: true });
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('kojo@example.com');
    expect(mail.subject).toMatch(/approved/);
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('kojo@example.com');
      expect(part).toContain('Ab3dEf6hJk9m');
      expect(part).toMatch(/insurance/);
    }
    expect(mail.text).toMatch(/^Hi Kojo,/);
  });

  it('escapes names so they cannot inject HTML', async () => {
    const { service, sendMail } = make();
    await service.sendPartnerApprovedEmail('a@b.co', { fullName: '<img src=x onerror=alert(1)> Smith', password: 'p<ss>word', motorcycle: false });
    const { html } = sendMail.mock.calls[0][0];
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('p&lt;ss&gt;word');
    expect(html).not.toMatch(/insurance/);
  });
});
