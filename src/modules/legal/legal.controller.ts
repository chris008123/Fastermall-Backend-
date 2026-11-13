import { Body, Controller, Get, Header, Param, Put, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { Response } from 'express';
import { LegalService } from './legal.service';
import { UpdateLegalPageDto } from './dto/legal-page.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

// Public: the apps link to these, before and after sign-in.
@Controller('legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  // { slug, title, content (Markdown), version, publishedAt }
  @Header('Cache-Control', 'public, max-age=300')
  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.legal.get(slug);
  }

  // The same page as a readable web page: set PRIVACY_URL / TERMS_URL to
  // <API>/legal/privacy/page and <API>/legal/terms/page.
  @SkipThrottle()
  @Get(':slug/page')
  async page(@Param('slug') slug: string, @Res() res: Response) {
    const html = await this.legal.renderPage(slug);
    res
      // The API-wide CSP blocks everything; this page only needs its own style.
      .setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
      .setHeader('Cache-Control', 'public, max-age=300')
      .type('html')
      .send(html);
  }
}

// Admin console. Each publish is recorded by the audit log automatically.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.ADMIN)
@Controller('admin/legal')
export class AdminLegalController {
  constructor(private readonly legal: LegalService) {}

  @Get()
  list() {
    return this.legal.listAll();
  }

  // Body: { title?, content }. Publishes at once as the next version.
  @Put(':slug')
  publish(@Param('slug') slug: string, @Body() dto: UpdateLegalPageDto, @CurrentUser() user: { userId: string }) {
    return this.legal.publish(slug, dto, user.userId);
  }
}
