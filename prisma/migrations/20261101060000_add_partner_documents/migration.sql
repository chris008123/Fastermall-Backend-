-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('ID_CARD', 'PROFILE_PHOTO', 'DRIVERS_LICENSE', 'VEHICLE_REGISTRATION', 'INSURANCE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADING', 'PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "partner_documents" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADING',
    "storagePath" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_documents_partnerId_type_idx" ON "partner_documents"("partnerId", "type");

-- CreateIndex
CREATE INDEX "partner_documents_status_createdAt_idx" ON "partner_documents"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "partner_documents" ADD CONSTRAINT "partner_documents_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "delivery_partner_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
