-- Delivery partner applications from the Delivery app. New enum and table only.
-- CreateEnum
CREATE TYPE "PartnerApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "partner_applications" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "address" TEXT NOT NULL,
    "partnerType" "DeliveryPartnerType" NOT NULL,
    "plateNumber" TEXT,
    "status" "PartnerApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "staffUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_applications_staffUserId_key" ON "partner_applications"("staffUserId");

-- CreateIndex
CREATE INDEX "partner_applications_status_createdAt_idx" ON "partner_applications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "partner_applications_phone_idx" ON "partner_applications"("phone");

-- CreateIndex
CREATE INDEX "partner_applications_email_idx" ON "partner_applications"("email");
