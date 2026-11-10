-- AlterTable
ALTER TABLE "delivery_partner_profiles" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "locationAccuracyM" DOUBLE PRECISION,
ADD COLUMN     "locationAt" TIMESTAMP(3);
