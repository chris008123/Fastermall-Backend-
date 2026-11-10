-- Marketplace delivery windows. New nullable columns only: existing orders
-- keep working and simply have no window.
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryWindowEnd" TIMESTAMP(3),
ADD COLUMN     "deliveryWindowStart" TIMESTAMP(3),
ADD COLUMN     "originalWindowStart" TIMESTAMP(3),
ADD COLUMN     "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rescheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "orders_deliveryWindowStart_idx" ON "orders"("deliveryWindowStart");
