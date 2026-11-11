-- Laundry multivendor. The original in-house service becomes the vendor
-- "fastermall-laundry"; every existing catalog item and laundry order is
-- moved onto it, so nothing changes for current customers.

-- CreateEnum
CREATE TYPE "LaundryVendorStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED');

-- CreateTable
CREATE TABLE "laundry_vendors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "location" TEXT,
    "phone" TEXT,
    "status" "LaundryVendorStatus" NOT NULL DEFAULT 'PENDING',
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "rating" DOUBLE PRECISION,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "commissionRate" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "laundry_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "laundry_vendor_reviews" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "laundry_vendor_reviews_pkey" PRIMARY KEY ("id")
);

-- The in-house service, approved and open.
INSERT INTO "laundry_vendors" ("id", "name", "description", "status", "isOpen", "updatedAt")
VALUES ('fastermall-laundry', 'Fastermall Laundry', 'The original Fastermall laundry service.', 'APPROVED', true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- AlterTable: catalog items belong to a vendor (existing ones to Fastermall).
ALTER TABLE "laundry_catalog_items" ADD COLUMN "vendorId" TEXT;
UPDATE "laundry_catalog_items" SET "vendorId" = 'fastermall-laundry' WHERE "vendorId" IS NULL;
ALTER TABLE "laundry_catalog_items" ALTER COLUMN "vendorId" SET NOT NULL;

-- AlterTable: orders record their vendor (existing ones: Fastermall).
ALTER TABLE "laundry_orders" ADD COLUMN "vendorId" TEXT;
UPDATE "laundry_orders" SET "vendorId" = 'fastermall-laundry' WHERE "vendorId" IS NULL;

-- AlterTable: laundry staff can be assigned to a vendor.
ALTER TABLE "staff_users" ADD COLUMN "laundryVendorId" TEXT;

-- CreateIndex
CREATE INDEX "laundry_vendors_status_rating_idx" ON "laundry_vendors"("status", "rating");

-- CreateIndex
CREATE INDEX "laundry_vendor_reviews_vendorId_createdAt_idx" ON "laundry_vendor_reviews"("vendorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_vendor_reviews_vendorId_userId_key" ON "laundry_vendor_reviews"("vendorId", "userId");

-- CreateIndex
CREATE INDEX "laundry_catalog_items_vendorId_idx" ON "laundry_catalog_items"("vendorId");

-- CreateIndex
CREATE INDEX "laundry_orders_vendorId_createdAt_idx" ON "laundry_orders"("vendorId", "createdAt");

-- AddForeignKey
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_laundryVendorId_fkey" FOREIGN KEY ("laundryVendorId") REFERENCES "laundry_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "laundry_catalog_items" ADD CONSTRAINT "laundry_catalog_items_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "laundry_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "laundry_orders" ADD CONSTRAINT "laundry_orders_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "laundry_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "laundry_vendor_reviews" ADD CONSTRAINT "laundry_vendor_reviews_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "laundry_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "laundry_vendor_reviews" ADD CONSTRAINT "laundry_vendor_reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
