-- Promotion Lottie animations and view/click/dismiss counters. New columns
-- only (nullable or with a default): existing promotions keep working.
-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "clickCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dismissCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lottieInfo" JSONB,
ADD COLUMN     "lottiePath" TEXT,
ADD COLUMN     "lottieUrl" TEXT,
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;
