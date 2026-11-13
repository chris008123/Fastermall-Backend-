import { BadRequestException } from '@nestjs/common';
// CommonJS form: this project compiles without esModuleInterop.
import sharp = require('sharp');

/** Longest side of the main picture, in pixels. Smaller pictures are not enlarged. */
export const MAIN_MAX_PX = 1600;
/** Longest side of the thumbnail used in lists and cards. */
export const THUMB_MAX_PX = 400;
const MAIN_QUALITY = 82;
const THUMB_QUALITY = 75;
// Refuse "decompression bombs": a small file that expands to a huge image.
// 40 megapixels covers any phone camera.
const MAX_INPUT_PIXELS = 40_000_000;

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  contentType: 'image/webp';
}

async function toWebp(input: Buffer, maxPx: number, quality: number): Promise<ProcessedImage> {
  const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    // Turn the picture the right way up using the camera's orientation tag
    // (the tag itself is then dropped with all the other metadata).
    .rotate()
    .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
    // Transparent PNGs keep their transparency; WebP supports it.
    .webp({ quality, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, contentType: 'image/webp' };
}

/**
 * Turns an uploaded JPEG, PNG or WebP into a WebP no larger than 1600 px on
 * its longest side. Hidden metadata (GPS location, camera details) is removed,
 * and animated images keep only their first frame. Throws a 400 if the file
 * can't be read as an image.
 */
export async function toMainWebp(input: Buffer): Promise<ProcessedImage> {
  return run(() => toWebp(input, MAIN_MAX_PX, MAIN_QUALITY));
}

/** Like toMainWebp, plus a 400 px thumbnail for lists and product cards. */
export async function toWebpWithThumbnail(input: Buffer): Promise<{ main: ProcessedImage; thumb: ProcessedImage }> {
  return run(async () => {
    const main = await toWebp(input, MAIN_MAX_PX, MAIN_QUALITY);
    // Made from the already-resized picture: same result, much less work.
    const thumb = await toWebp(main.buffer, THUMB_MAX_PX, THUMB_QUALITY);
    return { main, thumb };
  });
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (/pixel limit/i.test(message)) {
      throw new BadRequestException({ message: 'The image is too large (over 40 megapixels)', code: 'IMAGE_TOO_LARGE' });
    }
    throw new BadRequestException({ message: 'The image could not be read. Try saving it again as JPEG or PNG.', code: 'INVALID_IMAGE' });
  }
}
