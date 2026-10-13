-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('COD');

-- AlterTable
-- paymentMethod is null on every existing order: legacy and unspecified orders keep
-- the original rules and are not relabelled as cash on delivery. Existing orders
-- keep the currency the system has always used (USD); nothing is converted.
ALTER TABLE "Order" ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'USD',
ADD COLUMN     "paymentMethod" "PaymentMethod";


-- Prisma does not model the constraint below; it neither manages nor drops it.

-- The status and the payment status make sense together. This replaces the rule
-- the order lifecycle migration wrote, with one difference: a cash on delivery
-- order may be SHIPPED while its payment is still PENDING, because the cash is
-- collected when it arrives. Everything else is unchanged:
--   * DELIVERED always means PAID (the cash was collected);
--   * an order without a payment method (legacy) is paid before it ships;
--   * a cancelled order is never "paid" (paid and cancelled is "refunded");
--   * an order still being prepared is unpaid or paid, never refunded.
--
-- Every row the old rule accepted satisfies this one, so it cannot fail on
-- existing data. IS NOT DISTINCT FROM keeps a null paymentMethod from turning a
-- branch into NULL, which a CHECK would let through.
ALTER TABLE "Order" DROP CONSTRAINT "Order_payment_consistency_check";
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_consistency_check" CHECK (
  ("status" = 'DELIVERED' AND "paymentStatus" = 'PAID')
  OR ("status" = 'SHIPPED' AND "paymentStatus" = 'PAID')
  OR ("status" = 'SHIPPED' AND "paymentStatus" = 'PENDING' AND "paymentMethod" IS NOT DISTINCT FROM 'COD')
  OR ("status" = 'CANCELLED' AND "paymentStatus" IN ('PENDING', 'REFUNDED'))
  OR ("status" IN ('PENDING', 'PROCESSING') AND "paymentStatus" IN ('PENDING', 'PAID'))
);
