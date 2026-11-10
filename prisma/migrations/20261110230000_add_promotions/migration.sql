-- Promotions shown as a popup in the customer app. New types and table only.
-- CreateEnum
CREATE TYPE "PromotionCtaType" AS ENUM ('NONE', 'PRODUCT', 'CATEGORY', 'VENDOR', 'FOOD_VENDOR', 'URL');

-- CreateEnum
CREATE TYPE "PromotionFrequency" AS ENUM ('ONCE', 'DAILY', 'EVERY_OPEN');

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "body" TEXT,
    "imageUrl" TEXT,
    "imagePath" TEXT,
    "ctaLabel" TEXT,
    "ctaType" "PromotionCtaType" NOT NULL DEFAULT 'NONE',
    "ctaValue" TEXT,
    "theme" JSONB,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "frequency" "PromotionFrequency" NOT NULL DEFAULT 'ONCE',
    "announcedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotions_isActive_startsAt_endsAt_idx" ON "promotions"("isActive", "startsAt", "endsAt");
