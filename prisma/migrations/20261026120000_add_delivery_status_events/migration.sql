-- CreateTable
CREATE TABLE "delivery_status_events" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_status_events_deliveryId_createdAt_idx" ON "delivery_status_events"("deliveryId", "createdAt");

-- AddForeignKey
ALTER TABLE "delivery_status_events" ADD CONSTRAINT "delivery_status_events_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
