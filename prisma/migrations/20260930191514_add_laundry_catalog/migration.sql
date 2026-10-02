-- AlterTable
ALTER TABLE "laundry_items" ADD COLUMN     "catalogItemId" TEXT,
ADD COLUMN     "lineTotal" DECIMAL(10,2),
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unitPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "laundry_orders" ADD COLUMN     "deliveryFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "estimatedKg" DECIMAL(10,2),
ADD COLUMN     "laundryTotal" DECIMAL(10,2),
ADD COLUMN     "partnerId" TEXT,
ADD COLUMN     "pickupMode" TEXT,
ADD COLUMN     "pricePerKg" DECIMAL(10,2),
ADD COLUMN     "serviceId" TEXT,
ALTER COLUMN "servicePackage" DROP NOT NULL;

-- CreateTable
CREATE TABLE "laundry_partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "rating" DECIMAL(2,1),
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "turnaroundHours" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "laundry_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "laundry_services" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pricePerKg" DECIMAL(10,2) NOT NULL,
    "estimatedHours" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "laundry_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "laundry_catalog_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "laundry_catalog_items_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "laundry_services" ADD CONSTRAINT "laundry_services_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "laundry_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "laundry_orders" ADD CONSTRAINT "laundry_orders_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "laundry_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "laundry_orders" ADD CONSTRAINT "laundry_orders_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "laundry_services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "laundry_items" ADD CONSTRAINT "laundry_items_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "laundry_catalog_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
