-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "addressLabel" TEXT,
ADD COLUMN     "deliveryFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "vendorName" TEXT;
