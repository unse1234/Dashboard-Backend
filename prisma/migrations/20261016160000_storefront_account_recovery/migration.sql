-- Storefront account recovery: password reset tokens (bound to an account,
-- not an order) and the emails that carry new setup and reset links.
-- Additive: no existing row changes. Every existing token keeps its order.

-- AlterEnum
ALTER TYPE "EmailJobType" ADD VALUE 'ACCOUNT_SETUP_LINK';
ALTER TYPE "EmailJobType" ADD VALUE 'STOREFRONT_PASSWORD_RESET';

-- AlterEnum
ALTER TYPE "StorefrontTokenPurpose" ADD VALUE 'PASSWORD_RESET';

-- AlterTable
ALTER TABLE "StorefrontToken" ADD COLUMN     "accountId" TEXT,
ALTER COLUMN "orderId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Order_confirmationEmail_confirmationStatus_idx" ON "Order"("confirmationEmail", "confirmationStatus");

-- CreateIndex
CREATE INDEX "EmailJob_recipient_type_createdAt_idx" ON "EmailJob"("recipient", "type", "createdAt");

-- CreateIndex
CREATE INDEX "StorefrontToken_accountId_purpose_idx" ON "StorefrontToken"("accountId", "purpose");

-- AddForeignKey
ALTER TABLE "StorefrontToken" ADD CONSTRAINT "StorefrontToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StorefrontAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raw objects (not modelled by Prisma).

-- A password reset token belongs to an account and nothing else; every other
-- token belongs to an order and nothing else. The purpose is compared as text
-- because an enum value added in this transaction cannot be used as one yet.
ALTER TABLE "StorefrontToken" ADD CONSTRAINT "StorefrontToken_subject_check" CHECK (
  CASE WHEN "purpose"::text = 'PASSWORD_RESET'
    THEN "accountId" IS NOT NULL AND "orderId" IS NULL
    ELSE "orderId" IS NOT NULL AND "accountId" IS NULL
  END
);
