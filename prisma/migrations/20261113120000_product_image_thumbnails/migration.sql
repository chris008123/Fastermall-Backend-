-- Uploaded product photos are now converted to WebP (max 1600 px) with a
-- 400 px thumbnail. Nullable columns only: existing photos keep working.
ALTER TABLE "product_images" ADD COLUMN "width" INTEGER,
ADD COLUMN "height" INTEGER,
ADD COLUMN "thumbnailUrl" TEXT,
ADD COLUMN "thumbnailPath" TEXT;

ALTER TABLE "products" ADD COLUMN "thumbnailUrl" TEXT;
