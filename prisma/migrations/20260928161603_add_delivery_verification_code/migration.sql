-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "deliveryCodeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryCodeHash" TEXT,
ADD COLUMN     "deliveryCodeLockedUntil" TIMESTAMP(3),
ADD COLUMN     "deliveryCodeUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);
