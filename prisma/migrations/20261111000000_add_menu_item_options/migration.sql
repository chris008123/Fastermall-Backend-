-- Customisable food items: option groups and options on menu items, and a
-- snapshot of the chosen options on each order line. New tables and one
-- nullable column only.
-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "selectedOptions" JSONB;

-- CreateTable
CREATE TABLE "menu_item_option_groups" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_item_option_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_options" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "maxQuantity" INTEGER NOT NULL DEFAULT 1,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_item_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_item_option_groups_menuItemId_sortOrder_idx" ON "menu_item_option_groups"("menuItemId", "sortOrder");

-- CreateIndex
CREATE INDEX "menu_item_options_groupId_sortOrder_idx" ON "menu_item_options"("groupId", "sortOrder");

-- AddForeignKey
ALTER TABLE "menu_item_option_groups" ADD CONSTRAINT "menu_item_option_groups_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_options" ADD CONSTRAINT "menu_item_options_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "menu_item_option_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
