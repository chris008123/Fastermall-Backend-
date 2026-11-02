-- Records which admin accepted a marketplace or laundry delivery.
-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "claimedByStaffId" TEXT;

-- CreateIndex
CREATE INDEX "deliveries_claimedByStaffId_idx" ON "deliveries"("claimedByStaffId");

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_claimedByStaffId_fkey" FOREIGN KEY ("claimedByStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
