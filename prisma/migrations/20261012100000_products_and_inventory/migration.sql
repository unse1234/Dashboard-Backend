-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ProductEventType" AS ENUM ('CREATED', 'DETAILS_UPDATED', 'PRICE_CHANGED', 'STATUS_CHANGED', 'STOCK_CHANGED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "catalogProductId" TEXT;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "categoryId" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "price" DECIMAL(12,2) NOT NULL,
    "costPrice" DECIMAL(12,2),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "ProductEventType" NOT NULL,
    "data" JSONB NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_number_key" ON "Product"("number");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_createdAt_idx" ON "Product"("createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_productId_createdAt_idx" ON "ProductEvent"("productId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OrderItem_catalogProductId_idx" ON "OrderItem"("catalogProductId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma does not model the constraints, index and rows below; it neither manages nor drops them.

-- A SKU identifies a product, whatever its case, and stays reserved after the product
-- is archived (the same rule as a deleted user's email), so it is never reassigned.
CREATE UNIQUE INDEX "Product_sku_lower_key" ON "Product"(lower("sku"));

-- Prices are never negative.
ALTER TABLE "Product" ADD CONSTRAINT "Product_prices_check" CHECK ("price" >= 0 AND ("costPrice" IS NULL OR "costPrice" >= 0));

-- Stock is never below zero. This is what makes overselling impossible even if
-- application code is wrong: the update that would take it below zero fails.
ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_check" CHECK ("stock" >= 0);

ALTER TABLE "Product" ADD CONSTRAINT "Product_version_check" CHECK ("version" >= 1);

-- Cosmetic: start public ids at PRD-1001, like CUS-1001 and ORD-10001. The table is
-- new and empty, so no existing id changes.
ALTER SEQUENCE "Product_number_seq" RESTART WITH 1001;

-- The categories the product screens have always offered, so the filter and the form
-- have options from the start. Category management is not part of this release.
INSERT INTO "Category" ("id", "name", "updatedAt") VALUES
  (gen_random_uuid(), 'Accessories', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Electronics', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Furniture', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Home & Kitchen', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Office Supplies', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Sports & Outdoors', CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
