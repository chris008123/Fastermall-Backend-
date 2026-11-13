import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import { LegalService, renderMarkdown } from './legal.service';
import { AdminLegalController, LegalController } from './legal.controller';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

const PRIVACY = {
  slug: 'privacy',
  title: 'Fastermall Privacy Policy',
  content: '## 1. Who we are\n\nWe run the **Fastermall** apps.',
  version: 3,
  publishedAt: new Date('2026-11-13T10:00:00Z'),
  updatedById: 'a1',
  updatedAt: new Date('2026-11-13T10:00:00Z'),
};

function setup(row: any = PRIVACY) {
  const prisma: any = {
    legalPage: {
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue(row ? [row] : []),
      update: jest.fn(({ data }) => Promise.resolve({ ...row, ...data, version: row.version + 1 })),
    },
  };
  return { svc: new LegalService(prisma), prisma };
}

describe('LegalService public pages', () => {
  it('returns a published page', async () => {
    const { svc } = setup();
    await expect(svc.get('privacy')).resolves.toMatchObject({ title: 'Fastermall Privacy Policy', version: 3 });
  });

  it('404s on an unknown page without touching the database', async () => {
    const { svc, prisma } = setup();
    await expect(svc.get('cookies')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.legalPage.findUnique).not.toHaveBeenCalled();
  });

  it('renders a readable web page with the date and version', async () => {
    const { svc } = setup();
    const html = await svc.renderPage('privacy');
    expect(html).toContain('<title>Fastermall Privacy Policy</title>');
    expect(html).toContain('<h2>1. Who we are</h2>');
    expect(html).toContain('<strong>Fastermall</strong>');
    expect(html).toContain('Last updated 13 November 2026 · version 3');
  });
});

describe('renderMarkdown safety', () => {
  it('shows raw HTML as text instead of running it', () => {
    const out = renderMarkdown('Hello <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(out).not.toMatch(/<script|<img/i);
    expect(out).toContain('&lt;script&gt;');
  });

  it('keeps web, email, phone and relative links, and drops unsafe ones', () => {
    const out = renderMarkdown(
      '[site](https://fastermall.app) [mail](mailto:a@b.co) [call](tel:+233200000000) [terms](../terms/page) [bad](javascript:alert(1)) [data](data:text/html,x)',
    );
    expect(out).toContain('<a href="https://fastermall.app" rel="noopener noreferrer">site</a>');
    expect(out).toContain('<a href="mailto:a@b.co">mail</a>');
    expect(out).toContain('<a href="tel:+233200000000">call</a>');
    expect(out).toContain('<a href="../terms/page">terms</a>');
    expect(out).not.toMatch(/javascript:|data:text/);
    expect(out).toContain('bad');
  });

  it('renders tables and lists from the drafts', () => {
    const out = renderMarkdown('| Who | Why |\n| --- | --- |\n| Paystack | Payments |\n\n- one\n- two');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>Paystack</td>');
    expect(out).toContain('<li>one</li>');
  });

  it('drops images, keeping the alt text', () => {
    expect(renderMarkdown('![logo](https://x/logo.png)')).not.toContain('<img');
  });
});

describe('LegalService.publish', () => {
  it('publishes a change as the next version, recording who', async () => {
    const { svc, prisma } = setup();
    const out = await svc.publish('privacy', { content: '## Updated\r\n\r\nNew text that is long enough to publish.' }, 'admin9');
    const data = prisma.legalPage.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ title: PRIVACY.title, content: '## Updated\n\nNew text that is long enough to publish.', version: { increment: 1 }, updatedById: 'admin9' });
    expect(data.publishedAt).toBeInstanceOf(Date);
    expect(out.version).toBe(4);
  });

  it('keeps the same version when nothing changed', async () => {
    const { svc, prisma } = setup();
    await expect(svc.publish('privacy', { title: PRIVACY.title, content: PRIVACY.content }, 'a1')).resolves.toBe(PRIVACY);
    expect(prisma.legalPage.update).not.toHaveBeenCalled();
  });

  it('can rename the page', async () => {
    const { svc, prisma } = setup();
    await svc.publish('privacy', { title: 'Privacy Notice', content: PRIVACY.content }, 'a1');
    expect(prisma.legalPage.update.mock.calls[0][0].data.title).toBe('Privacy Notice');
  });

  it('refuses unknown pages and blank text', async () => {
    await expect(setup().svc.publish('cookies', { content: 'x'.repeat(60) }, 'a1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup().svc.publish('privacy', { content: ' '.repeat(60) }, 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup(null).svc.publish('privacy', { content: 'x'.repeat(60) }, 'a1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('legal routes', () => {
  it('reading is public', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LegalController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, LegalController.prototype.get)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, LegalController.prototype.page)).toBeUndefined();
  });

  it('editing is ADMIN only', () => {
    expect(new Reflector().get(ROLES_KEY, AdminLegalController)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminLegalController)).toContain(RolesGuard);
  });
});
