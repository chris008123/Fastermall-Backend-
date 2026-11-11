import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PreOrderStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../shared/storage/storage.service';
import { IMAGE_TYPES, sniffImageType, UploadedImage } from '../marketplace/product-images.service';
import {
  AdminPreOrderStatusDto,
  CreatePreOrderDto,
  CreateVariantDto,
  QuotePreOrderDto,
  UpdateVariantDto,
} from './dto/preorder.dto';

const MAX_SPEC_ENTRIES = 20;
const MAX_SPEC_TEXT = 200;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Who may move a request from which statuses.
const CUSTOMER_CANCELLABLE: PreOrderStatus[] = ['SUBMITTED', 'QUOTED'];
const ADMIN_QUOTABLE: PreOrderStatus[] = ['SUBMITTED', 'QUOTED'];
const ADMIN_CANCELLABLE: PreOrderStatus[] = ['SUBMITTED', 'QUOTED', 'ACCEPTED'];

const REQUEST_INCLUDE = {
  product: { select: { id: true, name: true, price: true, imageUrl: true } },
  variant: { select: { id: true, name: true, priceDelta: true, imageUrl: true } },
  images: { orderBy: { createdAt: 'asc' }, select: { id: true, path: true, contentType: true, createdAt: true } },
} satisfies Prisma.PreOrderRequestInclude;

type RequestRow = Prisma.PreOrderRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

/**
 * Pre-orders (requirement 2.12B). A customer asks for something made to
 * order; an admin quotes a price and an estimated date; the customer accepts
 * or declines; the admin marks it fulfilled. Paying for an accepted quote is
 * not built: that rule is still to be decided.
 */
@Injectable()
export class PreOrdersService {
  private readonly logger = new Logger(PreOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  protected now() {
    return new Date();
  }

  private get bucket() {
    return this.config.get<string>('preOrders.bucket') ?? 'preorder-references';
  }
  private get maxImages() {
    return this.config.get<number>('preOrders.maxImages') ?? 5;
  }

  // ───────── Customer ─────────

  async create(customerId: string, dto: CreatePreOrderDto) {
    const specifications = this.cleanSpecifications(dto.specifications);

    if (dto.variantId && !dto.productId) {
      throw new BadRequestException({ message: 'A design needs its product', code: 'INVALID_PREORDER' });
    }
    if (dto.productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: dto.productId },
        select: { id: true, allowsPreOrder: true },
      });
      if (!product) throw new NotFoundException('Product not found');
      if (!product.allowsPreOrder) {
        throw new BadRequestException({ message: 'This product cannot be pre-ordered', code: 'PREORDER_NOT_ALLOWED' });
      }
      if (dto.variantId) {
        const variant = await this.prisma.productVariant.findFirst({
          where: { id: dto.variantId, productId: dto.productId, isActive: true },
          select: { id: true },
        });
        if (!variant) throw new BadRequestException({ message: 'That design is not available for this product', code: 'INVALID_VARIANT' });
      }
    }

    const created = await this.prisma.preOrderRequest.create({
      data: {
        customerId,
        productId: dto.productId ?? null,
        variantId: dto.variantId ?? null,
        description: dto.description,
        specifications: specifications ?? Prisma.JsonNull,
        quantity: dto.quantity ?? 1,
      },
      include: REQUEST_INCLUDE,
    });
    this.events?.emit('preorder.submitted', { requestId: created.id, customerId });
    return this.present(created);
  }

  async listMine(customerId: string) {
    const rows = await this.prisma.preOrderRequest.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: REQUEST_INCLUDE,
    });
    return Promise.all(rows.map((r) => this.present(r)));
  }

  async findMine(customerId: string, id: string) {
    const row = await this.prisma.preOrderRequest.findFirst({ where: { id, customerId }, include: REQUEST_INCLUDE });
    if (!row) throw new NotFoundException('Pre-order not found');
    return this.present(row);
  }

  /** Reference photos, while the request is still waiting for a quote. */
  async addImages(customerId: string, id: string, files: UploadedImage[]) {
    const row = await this.prisma.preOrderRequest.findFirst({
      where: { id, customerId },
      select: { id: true, status: true, _count: { select: { images: true } } },
    });
    if (!row) throw new NotFoundException('Pre-order not found');
    if (row.status !== 'SUBMITTED') {
      throw new ConflictException({ message: 'Photos can only be added before the quote', code: 'PREORDER_LOCKED' });
    }
    if (!files?.length) throw new BadRequestException({ message: 'Attach at least one image in the "images" field', code: 'NO_IMAGE' });
    if (row._count.images + files.length > this.maxImages) {
      throw new ConflictException({ message: `At most ${this.maxImages} photos per request`, code: 'TOO_MANY_IMAGES' });
    }

    const checked = files.map((file) => {
      if (file.size > MAX_IMAGE_BYTES || file.buffer.length > MAX_IMAGE_BYTES) {
        throw new PayloadTooLargeException({ message: 'Each photo must be 5 MB or less', code: 'IMAGE_TOO_LARGE' });
      }
      const type = sniffImageType(file.buffer);
      if (!type) throw new BadRequestException({ message: 'Photos must be JPEG, PNG or WebP', code: 'UNSUPPORTED_IMAGE_TYPE' });
      return { file, type };
    });

    const uploaded: { path: string; type: string; size: number }[] = [];
    try {
      for (const { file, type } of checked) {
        const path = `preorders/${id}/${randomUUID()}.${IMAGE_TYPES[type]}`;
        await this.storage.uploadPrivate(this.bucket, path, file.buffer, type);
        uploaded.push({ path, type, size: file.buffer.length });
      }
      await this.prisma.preOrderImage.createMany({
        data: uploaded.map((u) => ({ requestId: id, path: u.path, contentType: u.type, sizeBytes: u.size })),
      });
    } catch (error) {
      await this.storage.removeFromBucket(this.bucket, uploaded.map((u) => u.path));
      throw error;
    }
    return this.findMine(customerId, id);
  }

  accept(customerId: string, id: string) {
    return this.customerDecision(customerId, id, ['QUOTED'], 'ACCEPTED');
  }

  decline(customerId: string, id: string, note?: string) {
    return this.customerDecision(customerId, id, ['QUOTED'], 'DECLINED', note);
  }

  cancel(customerId: string, id: string, note?: string) {
    return this.customerDecision(customerId, id, CUSTOMER_CANCELLABLE, 'CANCELLED', note);
  }

  private async customerDecision(
    customerId: string,
    id: string,
    from: PreOrderStatus[],
    to: PreOrderStatus,
    note?: string,
  ) {
    const row = await this.prisma.preOrderRequest.findFirst({ where: { id, customerId }, select: { status: true } });
    if (!row) throw new NotFoundException('Pre-order not found');
    await this.transition(id, from, to, {
      decidedAt: this.now(),
      ...(note !== undefined ? { customerNote: note || null } : {}),
    }, row.status);
    this.events?.emit('preorder.customer.decided', { requestId: id, customerId, status: to });
    return this.findMine(customerId, id);
  }

  // ───────── Admin ─────────

  async adminList(status?: string) {
    const rows = await this.prisma.preOrderRequest.findMany({
      where: status ? { status: status as PreOrderStatus } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: { ...REQUEST_INCLUDE, customer: { select: { id: true, fullName: true, phone: true, email: true } } },
    });
    return Promise.all(rows.map((r) => this.present(r)));
  }

  async adminFind(id: string) {
    const row = await this.prisma.preOrderRequest.findUnique({
      where: { id },
      include: { ...REQUEST_INCLUDE, customer: { select: { id: true, fullName: true, phone: true, email: true } } },
    });
    if (!row) throw new NotFoundException('Pre-order not found');
    return this.present(row);
  }

  /** Price and date for the request. A new quote replaces the old one. */
  async quote(id: string, dto: QuotePreOrderDto) {
    const row = await this.prisma.preOrderRequest.findUnique({ where: { id }, select: { status: true, customerId: true } });
    if (!row) throw new NotFoundException('Pre-order not found');
    const estimatedDate = new Date(dto.estimatedDate);
    if (estimatedDate.getTime() <= this.now().getTime()) {
      throw new BadRequestException({ message: 'The estimated date must be in the future', code: 'INVALID_DATE' });
    }
    await this.transition(id, ADMIN_QUOTABLE, 'QUOTED', {
      quotedPrice: new Prisma.Decimal(dto.price),
      estimatedDate,
      quotedAt: this.now(),
      adminNote: dto.note || null,
    }, row.status);
    this.events?.emit('preorder.quoted', { requestId: id, customerId: row.customerId, price: dto.price, estimatedDate: dto.estimatedDate });
    return this.adminFind(id);
  }

  /** FULFILLED (from ACCEPTED) or CANCELLED (before it is fulfilled). */
  async adminSetStatus(id: string, dto: AdminPreOrderStatusDto) {
    const row = await this.prisma.preOrderRequest.findUnique({ where: { id }, select: { status: true, customerId: true } });
    if (!row) throw new NotFoundException('Pre-order not found');
    const from: PreOrderStatus[] = dto.status === 'FULFILLED' ? ['ACCEPTED'] : ADMIN_CANCELLABLE;
    await this.transition(id, from, dto.status, { adminNote: dto.note ?? undefined }, row.status);
    this.events?.emit('preorder.status.updated', { requestId: id, customerId: row.customerId, status: dto.status, note: dto.note });
    return this.adminFind(id);
  }

  // Variants (designs) on a product.

  async createVariant(productId: string, dto: CreateVariantDto) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Product not found');
    this.assertHttps(dto.imageUrl);
    return this.prisma.productVariant.create({
      data: {
        productId,
        name: dto.name,
        description: dto.description || null,
        priceDelta: dto.priceDelta ?? 0,
        imageUrl: dto.imageUrl || null,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateVariant(id: string, dto: UpdateVariantDto) {
    if (Object.keys(dto).length === 0) throw new BadRequestException('Nothing to update');
    this.assertHttps(dto.imageUrl);
    try {
      return await this.prisma.productVariant.update({
        where: { id },
        data: { ...dto, ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl || null } : {}) },
      });
    } catch (e) {
      throw this.notFound(e, 'Design not found');
    }
  }

  /** Requests that named this design keep their text; the link is cleared. */
  async deleteVariant(id: string) {
    try {
      await this.prisma.productVariant.delete({ where: { id } });
    } catch (e) {
      throw this.notFound(e, 'Design not found');
    }
    return { deleted: true };
  }

  // ───────── Internals ─────────

  // Moves the status only if it is still one of `from` (two clicks, or the
  // customer and an admin at the same time, can't both win).
  private async transition(
    id: string,
    from: PreOrderStatus[],
    to: PreOrderStatus,
    data: Prisma.PreOrderRequestUpdateManyMutationInput,
    current: PreOrderStatus,
  ) {
    if (!from.includes(current)) {
      throw new ConflictException({
        message: `This pre-order is ${current.toLowerCase()} and cannot be marked ${to.toLowerCase()}`,
        code: 'INVALID_PREORDER_STATUS',
      });
    }
    const moved = await this.prisma.preOrderRequest.updateMany({
      where: { id, status: { in: from } },
      data: { ...data, status: to },
    });
    if (moved.count !== 1) {
      throw new ConflictException({ message: 'This pre-order just changed. Refresh and try again.', code: 'PREORDER_CHANGED' });
    }
  }

  private cleanSpecifications(specs?: Record<string, unknown>) {
    if (specs === undefined || specs === null) return null;
    const entries = Object.entries(specs);
    if (entries.length > MAX_SPEC_ENTRIES) {
      throw new BadRequestException({ message: `At most ${MAX_SPEC_ENTRIES} specifications`, code: 'INVALID_SPECIFICATIONS' });
    }
    const out: Record<string, string> = {};
    for (const [key, value] of entries) {
      const k = key.trim();
      if (!k || k.length > 60 || (typeof value !== 'string' && typeof value !== 'number') || String(value).trim().length > MAX_SPEC_TEXT) {
        throw new BadRequestException({
          message: 'Each specification needs a short label and a text value',
          code: 'INVALID_SPECIFICATIONS',
        });
      }
      out[k] = String(value).trim();
    }
    return entries.length ? out : null;
  }

  private assertHttps(url?: string | null) {
    if (url && !/^https:\/\/\S+$/i.test(url)) {
      throw new BadRequestException({ message: 'imageUrl must be an https link', code: 'INVALID_IMAGE_URL' });
    }
  }

  private notFound(e: unknown, message: string) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return new NotFoundException(message);
    return e;
  }

  // Swaps stored paths for short-lived links; a storage hiccup never hides the request.
  private async present<T extends RequestRow>(row: T) {
    let urls: (string | null)[] = row.images.map(() => null);
    if (row.images.length) {
      try {
        urls = await this.storage.signedUrls(this.bucket, row.images.map((i) => i.path), 600);
      } catch (error) {
        this.logger.warn(`Could not sign pre-order photos for ${row.id}: ${(error as Error).message}`);
      }
    }
    return {
      ...row,
      images: row.images.map((img, i) => ({ id: img.id, contentType: img.contentType, createdAt: img.createdAt, url: urls[i] })),
    };
  }
}
