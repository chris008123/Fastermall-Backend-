-- AlterTable
ALTER TABLE "users" ADD COLUMN     "codeFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeLockedUntil" TIMESTAMP(3),
ADD COLUMN     "loginFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loginLockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "staff_users" ADD COLUMN     "loginFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loginLockedUntil" TIMESTAMP(3);
