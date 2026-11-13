import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Marked } from 'marked';
import { PrismaService } from '../../database/prisma.service';
import { UpdateLegalPageDto } from './dto/legal-page.dto';

export const LEGAL_SLUGS = ['privacy', 'terms'] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

const PUBLIC_SELECT = { slug: true, title: true, content: true, version: true, publishedAt: true } as const;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Links may go to web pages, email, phone, or another page on this site.
// Anything else (javascript:, data:...) is shown as plain text.
const SAFE_HREF = /^(https?:|mailto:|tel:|\.{0,2}\/|#|[a-z0-9][a-z0-9._-]*(\/|$))/i;

// Admin-written Markdown. Raw HTML is shown as text, never run.
const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!href || !SAFE_HREF.test(href.trim())) return label;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      const external = /^https?:/i.test(href) ? ' rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(href.trim())}"${t}${external}>${label}</a>`;
    },
    image({ text }) {
      // No images on legal pages: keep the alt text only.
      return escapeHtml(text ?? '');
    },
  },
});

export function renderMarkdown(content: string): string {
  return markdown.parse(content, { async: false }) as string;
}

const dateLabel = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Accra' });

/**
 * The privacy policy and terms of use. Admins edit and publish them in the
 * console; the apps and anyone with the link read the published version.
 */
@Injectable()
export class LegalService {
  constructor(private readonly prisma: PrismaService) {}

  private assertSlug(slug: string): asserts slug is LegalSlug {
    if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) {
      throw new NotFoundException('Page not found');
    }
  }

  async get(slug: string) {
    this.assertSlug(slug);
    const page = await this.prisma.legalPage.findUnique({ where: { slug }, select: PUBLIC_SELECT });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  /** The page as a small, self-contained web page (what the apps open). */
  async renderPage(slug: string) {
    const page = await this.get(slug);
    const title = escapeHtml(page.title);
    return (
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      `<title>${title}</title><style>${PAGE_CSS}</style></head><body><main>` +
      `<h1>${title}</h1>` +
      `<p class="meta">Last updated ${escapeHtml(dateLabel(page.publishedAt))} · version ${page.version}</p>` +
      renderMarkdown(page.content) +
      '</main></body></html>'
    );
  }

  /** Admin: both pages, with who published them and when. */
  listAll() {
    return this.prisma.legalPage.findMany({ orderBy: { slug: 'asc' } });
  }

  /**
   * Admin: publish a new version. Nothing changes (and the version stays)
   * when the title and text are the same as now.
   */
  async publish(slug: string, dto: UpdateLegalPageDto, staffId: string) {
    this.assertSlug(slug);
    const current = await this.prisma.legalPage.findUnique({ where: { slug } });
    if (!current) throw new NotFoundException('Page not found');

    const title = dto.title ?? current.title;
    const content = dto.content.replace(/\r\n/g, '\n');
    if (title === current.title && content === current.content) return current;
    if (!content.trim()) throw new BadRequestException('The page cannot be empty');

    return this.prisma.legalPage.update({
      where: { slug },
      data: { title, content, version: { increment: 1 }, publishedAt: new Date(), updatedById: staffId },
    });
  }
}

const PAGE_CSS = [
  'body{margin:0;background:#fff;color:#1d2b33;font:16px/1.6 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
  'main{max-width:760px;margin:0 auto;padding:32px 20px 64px}',
  'h1{font-size:28px;line-height:1.25;margin:0 0 4px;color:#0b4f5c}',
  'h2{font-size:20px;margin:32px 0 8px;color:#0b4f5c}',
  '.meta{color:#5b6b73;font-size:14px;margin:0 0 24px}',
  'a{color:#1f7a8c}',
  'blockquote{margin:16px 0;padding:10px 14px;background:#fdebdc;border-radius:8px}',
  'blockquote p{margin:0}',
  'table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0;display:block;overflow-x:auto}',
  'th,td{border:1px solid #dce6e9;padding:8px;text-align:left;vertical-align:top}',
  'th{background:#f0f8f9}',
  'li{margin:4px 0}',
  'code{background:#f0f8f9;padding:1px 4px;border-radius:4px}',
  '@media (prefers-color-scheme:dark){body{background:#12191d;color:#e6edf0}h1,h2{color:#7fc7d4}.meta{color:#9fb3ba}a{color:#7fc7d4}th{background:#1c2a30}th,td{border-color:#2c3c43}blockquote{background:#3a2a1c}code{background:#1c2a30}}',
].join('');
