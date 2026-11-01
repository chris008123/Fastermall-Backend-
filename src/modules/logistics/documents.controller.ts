import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { AdminDocumentsQueryDto, ReviewDocumentDto } from './dto/admin-documents.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('logistics')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles(StaffRole.DELIVERY_PARTNER)
  @Get('me/documents')
  list(@CurrentUser() user: { userId: string }) {
    return this.documents.list(user.userId);
  }

  // The partner's own photo, as a 5-minute link.
  @Roles(StaffRole.DELIVERY_PARTNER)
  @Get('me/photo')
  photo(@CurrentUser() user: { userId: string }) {
    return this.documents.myPhoto(user.userId);
  }

  // Step 1: get a signed URL to upload the file to.
  @Roles(StaffRole.DELIVERY_PARTNER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('me/documents')
  create(@CurrentUser() user: { userId: string }, @Body() dto: CreateDocumentDto) {
    return this.documents.createUpload(user.userId, dto);
  }

  // Step 2: tell us the upload finished; the real file is checked here.
  @Roles(StaffRole.DELIVERY_PARTNER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('me/documents/:id/complete')
  complete(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.documents.completeUpload(user.userId, id);
  }

  @Roles(StaffRole.DELIVERY_PARTNER)
  @Delete('me/documents/:id')
  remove(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.documents.remove(user.userId, id);
  }

  // ---- Admin ----

  @Roles(StaffRole.ADMIN)
  @Get('admin/documents')
  adminList(@Query() q: AdminDocumentsQueryDto) {
    return this.documents.adminList(q.status, q.limit);
  }

  // A 60-second link to look at the file. Nothing is public.
  @Roles(StaffRole.ADMIN)
  @Get('admin/documents/:id/download')
  adminDownload(@Param('id') id: string) {
    return this.documents.adminDownloadUrl(id);
  }

  @Roles(StaffRole.ADMIN)
  @Patch('admin/documents/:id')
  adminReview(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ReviewDocumentDto,
  ) {
    return this.documents.adminReview(id, user.userId, dto);
  }
}
