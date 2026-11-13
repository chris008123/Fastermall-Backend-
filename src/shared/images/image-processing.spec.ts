import { BadRequestException } from '@nestjs/common';
import sharp = require('sharp');
import { toMainWebp, toWebpWithThumbnail } from './image-processing';

const make = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({ create: { width, height, channels, background: channels === 4 ? { r: 0, g: 0, b: 0, alpha: 0 } : '#1f7a8c' } });

describe('image processing', () => {
  it('turns a large JPEG into a 1600 px WebP and a 400 px thumbnail, keeping the shape', async () => {
    const input = await make(4000, 3000).jpeg({ quality: 95 }).toBuffer();
    const { main, thumb } = await toWebpWithThumbnail(input);

    expect(main).toMatchObject({ contentType: 'image/webp', width: 1600, height: 1200 });
    expect(thumb).toMatchObject({ contentType: 'image/webp', width: 400, height: 300 });
    expect((await sharp(main.buffer).metadata()).format).toBe('webp');
    expect((await sharp(thumb.buffer).metadata()).format).toBe('webp');
    expect(thumb.buffer.length).toBeLessThan(main.buffer.length);
  });

  it('never enlarges a small picture', async () => {
    const { main, thumb } = await toWebpWithThumbnail(await make(300, 200).png().toBuffer());
    expect(main).toMatchObject({ width: 300, height: 200 });
    expect(thumb).toMatchObject({ width: 300, height: 200 });
  });

  it('a tall picture is capped on its height', async () => {
    const main = await toMainWebp(await make(1000, 3200).jpeg().toBuffer());
    expect(main).toMatchObject({ width: 500, height: 1600 });
  });

  it('removes hidden metadata such as GPS location', async () => {
    const withGps = await make(800, 600)
      .jpeg()
      .withExif({ IFD0: { Make: 'PhoneCo', Model: 'X1' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '5/1 33/1 0/1' } })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    const main = await toMainWebp(withGps);
    const meta = await sharp(main.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });

  it('turns a sideways phone photo the right way up', async () => {
    // Stored 800 x 600 with "rotate 90°" in the orientation tag: shown as 600 x 800.
    const sideways = await make(800, 600).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const main = await toMainWebp(sideways);
    expect(main).toMatchObject({ width: 600, height: 800 });
  });

  it('keeps transparency from a PNG', async () => {
    const main = await toMainWebp(await make(100, 100, 4).png().toBuffer());
    expect((await sharp(main.buffer).metadata()).hasAlpha).toBe(true);
  });

  it('refuses a broken file with a clear 400', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
    const err: any = await toMainWebp(broken).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'INVALID_IMAGE' });
  });

  it('refuses an image over 40 megapixels', async () => {
    // A tiny PNG file that decodes to 8000 x 6000 = 48 megapixels.
    const huge = await make(8000, 6000).png({ compressionLevel: 9 }).toBuffer();
    const err: any = await toMainWebp(huge).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });
});
