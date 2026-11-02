-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "laundry_orders" ADD COLUMN     "addressLabel" TEXT,
ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "riderLat" DOUBLE PRECISION,
ADD COLUMN     "riderLng" DOUBLE PRECISION,
ADD COLUMN     "riderLocationAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "announcements" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "orderUpdates" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetType" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_customerId_idempotencyKey_key" ON "orders"("customerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "laundry_orders_customerId_idempotencyKey_key" ON "laundry_orders"("customerId", "idempotencyKey");

