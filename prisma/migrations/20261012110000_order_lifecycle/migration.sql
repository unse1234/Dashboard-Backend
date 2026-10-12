-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('CREATED', 'STATUS_CHANGED', 'PAYMENT_STATUS_CHANGED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "itemCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "OrderEventType" NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus",
    "fromPaymentStatus" "PaymentStatus",
    "toPaymentStatus" "PaymentStatus",
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Prisma does not model the constraints below; it neither manages nor drops them.

-- Existing orders: the units across their lines. Existing lines keep position 0
-- (the order they were placed in was never recorded), so they list by id.
UPDATE "Order" o
SET "itemCount" = s."units"
FROM (
  SELECT "orderId", COALESCE(SUM("quantity"), 0)::int AS "units"
  FROM "OrderItem"
  GROUP BY "orderId"
) s
WHERE s."orderId" = o."id";

ALTER TABLE "Order" ADD CONSTRAINT "Order_item_count_check" CHECK ("itemCount" >= 0);

-- The status and the payment status make sense together. This is the dashboard's
-- own rule (the API enforces it on every change) written down where nothing can
-- get around it: an order that shipped was paid, a cancelled order is never "paid"
-- (a cancelled order that was paid is "refunded"), and an order still being
-- prepared is unpaid or paid, never refunded.
--
-- This fails if existing rows break the rule. Check first with:
--   SELECT count(*) FROM "Order" WHERE NOT (
--     ("status" IN ('SHIPPED','DELIVERED') AND "paymentStatus" = 'PAID')
--     OR ("status" = 'CANCELLED' AND "paymentStatus" IN ('PENDING','REFUNDED'))
--     OR ("status" IN ('PENDING','PROCESSING') AND "paymentStatus" IN ('PENDING','PAID')));
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_consistency_check" CHECK (
  ("status" IN ('SHIPPED', 'DELIVERED') AND "paymentStatus" = 'PAID')
  OR ("status" = 'CANCELLED' AND "paymentStatus" IN ('PENDING', 'REFUNDED'))
  OR ("status" IN ('PENDING', 'PROCESSING') AND "paymentStatus" IN ('PENDING', 'PAID'))
);

-- Lines are at least one unit (already checked); a position is never negative.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_position_check" CHECK ("position" >= 0);
