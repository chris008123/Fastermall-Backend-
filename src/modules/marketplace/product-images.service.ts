import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../shared/storage/storage.service';

/** The parts of a multer file we use (memory storage). */
export interface UploadedImage {
  originalname?: string;
  mimetype?: string;
  size: number;
  buffer: Buffer;
}

export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type ImageType = keyof typeof IMAGE_TYPES;

/**
 * The real type of an image, read from its first bytes. The file name and the
 * type the browser sends are ignored: a renamed PDF or script is refused.
 */
export function sniffImageType(buffer: Buffer): ImageType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

const IMAGE_SELECT = {
  id: true,
  url: true,
  sortOrder: true,
  contentType: true,
  sizeBytes: true,
  createdAt: true,
} satisfies Prisma.ProductImageSelect;

/**
 * Product photos (requirement 2.2). Admins upload them; they are stored in a
 * public Supabase bucket and shown in the marketplace. A product has up to
 * PRODUCT_IMAGES_MAX photos (default 5); the first one is also written to
 * Product.imageUrl so older apps keep showing it.
 */
@Injectable()
export class ProductImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  get bucket() {
    return this.config.get<string>('productImages.bucket') ?? 'product-images';
  }
  get maxBytes() {
    return this.config.get<number>('productImages.maxBytes') ?? 5 * 1024 * 1024;
  }
  get maxPerProduct() {
    return this.config.get<number>('productImages.maxPerProduct') ?? 5;
  }

  private async assertProduct(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Product not found');
  }

  list(productId: string) {
    return this.prisma.productImage.findMany({
      where: { productId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: IMAGE_SELECT,
    });
  }

  /**
   * Adds photos after the existing ones. Every file is checked first (real
   * type, size, the per-product limit); if any is refused, nothing is
   * uploaded. Returns the product's photos in order.
   */
  async add(productId: string, files: UploadedImage[]) {
    await this.assertProduct(productId);
    if (!files?.length) {
      throw new BadRequestException({ message: 'Attach at least one image in the "images" field', code: 'NO_IMAGE' });
    }

    const checked = files.map((file, i) => {
      const label = file.originalname ? `"${file.originalname}"` : `Image ${i + 1}`;
      if (file.size > this.maxBytes || file.buffer.length > this.maxBytes) {
        throw new PayloadTooLargeException({
          message: `${label} is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB`,
          code: 'IMAGE_TOO_LARGE',
        });
      }
      const type = sniffImageType(file.buffer);
      if (!type) {
        throw new BadRequestException({
          message: `${label} is not a JPEG, PNG or WebP image`,
          code: 'UNSUPPORTED_IMAGE_TYPE',
        });
      }
      return { file, type };
    });

    const existing = await this.prisma.productImage.count({ where: { productId } });
    if (existing + checked.length > this.maxPerProduct) {
      throw new ConflictException({
        message: `A product can have at most ${this.maxPerProduct} images (it has ${existing})`,
        code: 'TOO_MANY_IMAGES',
      });
    }

    // Upload first; only record the ones that made it, and clean up on failure.
    const uploaded: { path: string; publicUrl: string; type: ImageType; size: number }[] = [];
    try {
      for (const { file, type } of checked) {
        const path = `products/${productId}/${randomUUID()}.${IMAGE_TYPES[type]}`;
        const { publicUrl } = await this.storage.uploadPublic(this.bucket, path, file.buffer, type);
        uploaded.push({ path, publicUrl, type, size: file.buffer.length });
      }

      const last = await this.prisma.productImage.aggregate({
        where: { productId },
        _max: { sortOrder: true },
      });
      const start = (last._max.sortOrder ?? -1) + 1;

      await this.prisma.$transaction([
        this.prisma.productImage.createMany({
          data: uploaded.map((u, i) => ({
            productId,
            url: u.publicUrl,
            path: u.path,
            contentType: u.type,
            sizeBytes: u.size,
            sortOrder: start + i,
          })),
        }),
      ]);
    } catch (error) {
      await this.storage.removeFromBucket(this.bucket, uploaded.map((u) => u.path));
      throw error;
    }

    return this.syncPrimary(productId);
  }

  /** Removes one photo (and its file). The next one becomes the main image. */
  async remove(productId: string, imageId: string) {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
      select: { id: true, path: true },
    });
    if (!image) throw new NotFoundException('Image not found');

    await this.prisma.productImage.delete({ where: { id: image.id } });
    await this.storage.removeFromBucket(this.bucket, [image.path]);
    return this.syncPrimary(productId);
  }

  /**
   * Sets the display order. `imageIds` must list every photo of the product
   * exactly once; the first becomes the main image.
   */
  async reorder(productId: string, imageIds: string[]) {
    await this.assertProduct(productId);
    const current = await this.prisma.productImage.findMany({ where: { productId }, select: { id: true } });
    const ids = new Set(current.map((c) => c.id));
    if (imageIds.length !== ids.size || new Set(imageIds).size !== imageIds.length || imageIds.some((id) => !ids.has(id))) {
      throw new BadRequestException({
        message: 'List every image of this product exactly once',
        code: 'INVALID_IMAGE_ORDER',
      });
    }

    await this.prisma.$transaction(
      imageIds.map((id, sortOrder) => this.prisma.productImage.update({ where: { id }, data: { sortOrder } })),
    );
    return this.syncPrimary(productId);
  }

  /** Storage paths of a product's photos (read before deleting the product). */
  async pathsOf(productId: string) {
    const images = await this.prisma.productImage.findMany({ where: { productId }, select: { path: true } });
    return images.map((i) => i.path);
  }

  /** Best effort: removes files whose rows are already gone. */
  removeFiles(paths: string[]) {
    return this.storage.removeFromBucket(this.bucket, paths);
  }

  /**
   * Writes the first photo's URL to Product.imageUrl. With no photos left it
   * becomes null, except a URL set by hand from elsewhere (not this bucket),
   * which is kept until the first upload replaces it.
   */
  private async syncPrimary(productId: string) {
    const images = await this.list(productId);
    let imageUrl: string | null = images[0]?.url ?? null;
    if (!imageUrl) {
      const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { imageUrl: true } });
      const external = product?.imageUrl && !product.imageUrl.includes(`/${this.bucket}/`);
      imageUrl = external ? product!.imageUrl : null;
    }
    await this.prisma.product.update({ where: { id: productId }, data: { imageUrl } });
    return { productId, imageUrl, images };
  }
}
