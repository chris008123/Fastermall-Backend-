/*
  Warnings:

  - You are about to drop the column `partnerId` on the `laundry_orders` table. All the data in the column will be lost.
  - You are about to drop the column `pricePerKg` on the `laundry_orders` table. All the data in the column will be lost.
  - You are about to drop the column `serviceId` on the `laundry_orders` table. All the data in the column will be lost.
  - You are about to drop the column `servicePackage` on the `laundry_orders` table. All the data in the column will be lost.
  - You are about to drop the `laundry_partners` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `laundry_services` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "laundry_orders" DROP CONSTRAINT "laundry_orders_partnerId_fkey";

-- DropForeignKey
ALTER TABLE "laundry_orders" DROP CONSTRAINT "laundry_orders_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "laundry_services" DROP CONSTRAINT "laundry_services_partnerId_fkey";

-- AlterTable
ALTER TABLE "laundry_orders" DROP COLUMN "partnerId",
DROP COLUMN "pricePerKg",
DROP COLUMN "serviceId",
DROP COLUMN "servicePackage";

-- DropTable
DROP TABLE "laundry_partners";

-- DropTable
DROP TABLE "laundry_services";
