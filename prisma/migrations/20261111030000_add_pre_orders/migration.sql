-- Pre-orders: product variants, pre-order requests and their reference
-- photos. New tables, one enum, and two columns on products with defaults.
-- CreateEnum
CREATE TYPE "PreOrderStatus" AS ENUM ('SUBMITTED', 'QUOTED', 'ACCEPTED', 'DECLINED', 'FULFILLED', 'CANCELLED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "allowsPreOrder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preOrderLeadDays" INTEGER;

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceDelta" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_order_requests" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "description" TEXT NOT NULL,
    "specifications" JSONB,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "PreOrderStatus" NOT NULL DEFAULT 'SUBMITTED',
    "quotedPrice" DECIMAL(10,2),
    "estimatedDate" TIMESTAMP(3),
    "quotedAt" TIMESTAMP(3),
    "adminNote" TEXT,
    "customerNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pre_order_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_order_images" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_order_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_variants_productId_sortOrder_idx" ON "product_variants"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "pre_order_requests_customerId_createdAt_idx" ON "pre_order_requests"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "pre_order_requests_status_createdAt_idx" ON "pre_order_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "pre_order_images_requestId_idx" ON "pre_order_images"("requestId");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_order_requests" ADD CONSTRAINT "pre_order_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_order_requests" ADD CONSTRAINT "pre_order_requests_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_order_requests" ADD CONSTRAINT "pre_order_requests_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_order_images" ADD CONSTRAINT "pre_order_images_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "pre_order_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
