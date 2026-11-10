-- AlterTable
ALTER TABLE "staff_users" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "resetAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resetCodeHash" TEXT,
ADD COLUMN     "resetExpiresAt" TIMESTAMP(3);
