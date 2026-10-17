-- AlterTable
ALTER TABLE "food_vendors" ADD COLUMN     "ownerStaffId" TEXT;

-- CreateIndex
CREATE INDEX "food_vendors_ownerStaffId_idx" ON "food_vendors"("ownerStaffId");

-- AddForeignKey
ALTER TABLE "food_vendors" ADD CONSTRAINT "food_vendors_ownerStaffId_fkey" FOREIGN KEY ("ownerStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
