import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DocumentStatus, DocumentType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../shared/storage/storage.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { ReviewDocumentDto } from './dto/admin-documents.dto';

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

// What a partner must have approved. Walking partners need no vehicle papers.
const REQUIRED_ALWAYS: DocumentType[] = ['ID_CARD', 'PROFILE_PHOTO'] as DocumentType[];
const REQUIRED_MOTORCYCLE: DocumentType[] = ['DRIVERS_LICENSE', 'VEHICLE_REGISTRATION', 'INSURANCE'] as DocumentType[];
// These expire, so an expiry date is required.
const NEEDS_EXPIRY: DocumentType[] = ['DRIVERS_LICENSE', 'INSURANCE', 'VEHICLE_REGISTRATION'] as DocumentType[];
// Photos only.
const IMAGE_ONLY: DocumentType[] = ['PROFILE_PHOTO'] as DocumentType[];

const MAX_ACTIVE_DOCUMENTS = 15;
const EXPIRING_SOON_DAYS = 30;

const LABEL: Record<string, string> = {
  ID_CARD: 'ID card',
  PROFILE_PHOTO: 'Profile photo',
  DRIVERS_LICENSE: "Driver's licence",
  VEHICLE_REGISTRATION: 'Vehicle registration',
  INSURANCE: 'Insurance',
};

/**
 * Partner verification documents. Files go phone -> private storage through a
 * signed upload URL; this service only handles the paperwork around them.
 *
 * Not done here: virus scanning. Files are only ever opened by admins through a
 * 60-second signed link, but put a scanner (for example ClamAV on upload
 * events) in front of them before opening this to many partners.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  private get maxBytes() {
    return this.config.get<number>('documents.maxBytes') ?? 5 * 1024 * 1024;
  }

  private async profileFor(userId: string) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({
      where: { staffUserId: userId },
      select: { id: true, type: true, staffUserId: true },
    });
    if (!profile) throw new NotFoundException('You are not registered as a delivery partner');
    return profile;
  }

  // What the partner app sees. The storage path is never included.
  private view(d: any) {
    return {
      id: d.id,
      type: d.type,
      status: d.status,
      contentType: d.contentType,
      sizeBytes: d.sizeBytes,
      expiresAt: d.expiresAt ?? null,
      rejectionReason: d.rejectionReason ?? null,
      createdAt: d.createdAt,
    };
  }

  private requiredFor(partnerType: string): DocumentType[] {
    return partnerType === 'MOTORCYCLE' ? [...REQUIRED_ALWAYS, ...REQUIRED_MOTORCYCLE] : REQUIRED_ALWAYS;
  }

  /** Step 1: ask for permission to upload. Returns where to send the file. */
  async createUpload(userId: string, dto: CreateDocumentDto) {
    const profile = await this.profileFor(userId);

    if (dto.sizeBytes > this.maxBytes) {
      throw new UnprocessableEntityException({
        message: `The file is too large (limit ${Math.floor(this.maxBytes / 1024 / 1024)} MB)`,
        code: 'FILE_TOO_LARGE',
      });
    }
    if (IMAGE_ONLY.includes(dto.type) && dto.contentType === 'application/pdf') {
      throw new UnprocessableEntityException({ message: 'Send a photo for this document', code: 'IMAGE_REQUIRED' });
    }

    let expiresAt: Date | null = null;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (expiresAt <= new Date()) {
        throw new UnprocessableEntityException({ message: 'This document has already expired', code: 'DOCUMENT_EXPIRED' });
      }
    } else if (NEEDS_EXPIRY.includes(dto.type)) {
      throw new BadRequestException({ message: 'Enter the expiry date', code: 'EXPIRY_REQUIRED' });
    }

    const active = await this.prisma.partnerDocument.count({
      where: { partnerId: profile.id, status: { not: 'SUPERSEDED' as DocumentStatus } },
    });
    if (active >= MAX_ACTIVE_DOCUMENTS) {
      throw new ConflictException({ message: 'Too many documents. Delete one first.', code: 'TOO_MANY_DOCUMENTS' });
    }

    // The path is built here from our own ids: never from a file name the
    // phone sent.
    const doc = await this.prisma.partnerDocument.create({
      data: {
        partnerId: profile.id,
        type: dto.type,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
        expiresAt,
        storagePath: 'pending',
      },
    });
    const path = `partners/${profile.id}/${doc.id}.${EXTENSION[dto.contentType]}`;
    await this.prisma.partnerDocument.update({ where: { id: doc.id }, data: { storagePath: path } });

    let upload;
    try {
      upload = await this.storage.createSignedUpload(path);
    } catch (error) {
      await this.prisma.partnerDocument.delete({ where: { id: doc.id } });
      throw error;
    }

    return {
      document: this.view({ ...doc, storagePath: undefined }),
      upload: {
        // Upload the file to this URL (supabase-js: uploadToSignedUrl(path, token, file)).
        url: upload.signedUrl,
        token: upload.token,
        path: upload.path,
        bucket: this.storage.bucket,
        maxBytes: this.maxBytes,
      },
    };
  }

  /** Step 2: after uploading. Checks the real file, then queues it for review. */
  async completeUpload(userId: string, id: string) {
    const profile = await this.profileFor(userId);
    const doc = await this.prisma.partnerDocument.findFirst({ where: { id, partnerId: profile.id } });
    if (!doc) throw new NotFoundException('Document not found');

    // Calling this twice is fine.
    if (doc.status !== 'UPLOADING') return this.view(doc);

    const stored = await this.storage.stat(doc.storagePath);
    if (!stored) {
      throw new ConflictException({ message: 'The file has not finished uploading', code: 'UPLOAD_NOT_FOUND' });
    }

    const typeOk = stored.contentType === doc.contentType;
    const sizeOk = stored.size > 0 && stored.size <= this.maxBytes;
    if (!typeOk || !sizeOk) {
      await this.storage.remove(doc.storagePath);
      await this.prisma.partnerDocument.delete({ where: { id: doc.id } });
      throw new UnprocessableEntityException({
        message: !sizeOk ? 'The file is too large or empty' : 'The file type does not match what you said',
        code: 'FILE_NOT_ACCEPTED',
      });
    }

    const done = await this.prisma.partnerDocument.update({
      where: { id: doc.id },
      data: { status: 'PENDING' as DocumentStatus, sizeBytes: stored.size },
    });
    return this.view(done);
  }

  /** The partner's documents plus where they stand on verification. */
  async list(userId: string) {
    const profile = await this.profileFor(userId);
    const docs = await this.prisma.partnerDocument.findMany({
      where: { partnerId: profile.id, status: { not: 'SUPERSEDED' as DocumentStatus } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: docs.map((d) => this.view(d)), verification: this.verificationOf(profile.type, docs) };
  }

  private verificationOf(partnerType: string, docs: { type: any; status: any; expiresAt: Date | null }[]) {
    const now = new Date();
    const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000);
    const approved = docs.filter((d) => d.status === 'APPROVED' && (!d.expiresAt || d.expiresAt > now));
    const required = this.requiredFor(partnerType);
    const missing = required.filter((t) => !approved.some((d) => d.type === t));
    return {
      status: missing.length === 0 ? 'VERIFIED' : 'INCOMPLETE',
      required,
      missing,
      expiringSoon: approved.filter((d) => d.expiresAt && d.expiresAt <= soon).map((d) => d.type),
    };
  }

  async remove(userId: string, id: string) {
    const profile = await this.profileFor(userId);
    const doc = await this.prisma.partnerDocument.findFirst({ where: { id, partnerId: profile.id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status === 'APPROVED') {
      throw new ConflictException({
        message: 'An approved document cannot be deleted. Upload a new one to replace it.',
        code: 'DOCUMENT_APPROVED',
      });
    }
    await this.storage.remove(doc.storagePath);
    await this.prisma.partnerDocument.delete({ where: { id } });
    return { removed: true };
  }

  /**
   * Used before accepting a job, when PARTNER_REQUIRE_VERIFICATION is on.
   * Admins and a switched-off requirement always pass.
   */
  async assertCanWork(userId: string, role?: string) {
    if (role === 'ADMIN' || !this.config.get<boolean>('documents.requireVerification')) return;
    const { verification } = await this.list(userId);
    if (verification.status !== 'VERIFIED') {
      throw new ForbiddenException({
        message: 'Your documents must be approved before you can accept jobs',
        code: 'NOT_VERIFIED',
        missing: verification.missing,
      });
    }
  }

  // ---- Admin ----

  async adminList(status?: DocumentStatus, limit = 50) {
    const rows = await this.prisma.partnerDocument.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { partner: { include: { staffUser: { select: { fullName: true, phone: true } } } } },
    });
    return rows.map((d) => ({
      ...this.view(d),
      partnerId: d.partnerId,
      partnerName: d.partner.staffUser.fullName,
      partnerPhone: d.partner.staffUser.phone,
      reviewedAt: d.reviewedAt,
    }));
  }

  async adminDownloadUrl(id: string) {
    const doc = await this.prisma.partnerDocument.findUnique({ where: { id } });
    if (!doc || doc.status === 'UPLOADING') throw new NotFoundException('Document not found');
    return { url: await this.storage.createSignedDownload(doc.storagePath, 60), expiresInSeconds: 60 };
  }

  async adminReview(id: string, adminId: string, dto: ReviewDocumentDto) {
    if (dto.status === 'REJECTED' && !dto.rejectionReason?.trim()) {
      throw new BadRequestException({
        message: 'Say why the document was rejected',
        code: 'REJECTION_REASON_REQUIRED',
      });
    }

    const doc = await this.prisma.partnerDocument.findUnique({
      where: { id },
      include: { partner: { select: { staffUserId: true } } },
    });
    if (!doc) throw new NotFoundException('Document not found');

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;

    // Only a document waiting for review can be reviewed, and only once.
    const changed = await this.prisma.partnerDocument.updateMany({
      where: { id, status: 'PENDING' as DocumentStatus },
      data: {
        status: dto.status as DocumentStatus,
        rejectionReason: dto.status === 'REJECTED' ? dto.rejectionReason!.trim() : null,
        reviewedById: adminId,
        reviewedAt: new Date(),
        ...(expiresAt ? { expiresAt } : {}),
      },
    });
    if (changed.count === 0) {
      throw new ConflictException({
        message: 'This document is not waiting for review',
        code: 'DOCUMENT_NOT_PENDING',
      });
    }

    // A newly approved document replaces older ones of the same type.
    if (dto.status === 'APPROVED') {
      const older = await this.prisma.partnerDocument.findMany({
        where: { partnerId: doc.partnerId, type: doc.type, id: { not: id }, status: { not: 'SUPERSEDED' as DocumentStatus } },
        select: { id: true, storagePath: true },
      });
      if (older.length) {
        await this.prisma.partnerDocument.updateMany({
          where: { id: { in: older.map((o) => o.id) } },
          data: { status: 'SUPERSEDED' as DocumentStatus },
        });
        await Promise.all(older.map((o) => this.storage.remove(o.storagePath)));
      }
    }

    this.events.emit('partner.document.reviewed', {
      staffUserId: doc.partner.staffUserId,
      documentId: id,
      documentLabel: LABEL[doc.type] ?? 'Document',
      status: dto.status,
      reason: dto.status === 'REJECTED' ? dto.rejectionReason!.trim() : undefined,
    });

    return this.view(await this.prisma.partnerDocument.findUniqueOrThrow({ where: { id } }));
  }
}
