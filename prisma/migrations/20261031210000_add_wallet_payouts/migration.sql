-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "delivery_partner_profiles" ADD COLUMN     "payoutNetwork" TEXT,
ADD COLUMN     "payoutNumber" TEXT;

-- CreateTable
CREATE TABLE "payout_requests" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "amountPesewas" INTEGER NOT NULL,
    "feePesewas" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "network" TEXT NOT NULL,
    "destinationNumber" TEXT NOT NULL,
    "destinationMasked" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_requests_partnerId_createdAt_idx" ON "payout_requests"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "payout_requests_status_createdAt_idx" ON "payout_requests"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "delivery_partner_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
