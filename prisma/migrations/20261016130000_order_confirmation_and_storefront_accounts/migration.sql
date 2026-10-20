-- CreateEnum
CREATE TYPE "OrderConfirmationStatus" AS ENUM ('EXEMPT', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StorefrontTokenPurpose" AS ENUM ('ORDER_CONFIRMATION', 'ACCOUNT_SETUP');

-- CreateEnum
CREATE TYPE "EmailJobType" AS ENUM ('ORDER_CONFIRMATION');

-- CreateEnum
CREATE TYPE "EmailJobStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "confirmationEmail" TEXT,
ADD COLUMN     "confirmationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "confirmationStatus" "OrderConfirmationStatus" NOT NULL DEFAULT 'EXEMPT',
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "storefrontAccountId" TEXT;

-- CreateTable
CREATE TABLE "StorefrontAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorefrontAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorefrontSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "previousRefreshTokenHash" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "SessionRevokeReason",
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorefrontSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorefrontToken" (
    "id" TEXT NOT NULL,
    "purpose" "StorefrontTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorefrontToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailJob" (
    "id" TEXT NOT NULL,
    "type" "EmailJobType" NOT NULL,
    "status" "EmailJobStatus" NOT NULL DEFAULT 'PENDING',
    "recipient" TEXT NOT NULL,
    "orderId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptToken" TEXT,
    "attemptExpiresAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontAccount_email_key" ON "StorefrontAccount"("email");

-- CreateIndex
CREATE INDEX "StorefrontSession_accountId_revokedAt_idx" ON "StorefrontSession"("accountId", "revokedAt");

-- CreateIndex
CREATE INDEX "StorefrontSession_expiresAt_idx" ON "StorefrontSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontToken_tokenHash_key" ON "StorefrontToken"("tokenHash");

-- CreateIndex
CREATE INDEX "StorefrontToken_orderId_purpose_idx" ON "StorefrontToken"("orderId", "purpose");

-- CreateIndex
CREATE INDEX "StorefrontToken_expiresAt_idx" ON "StorefrontToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailJob_idempotencyKey_key" ON "EmailJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EmailJob_status_nextAttemptAt_idx" ON "EmailJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailJob_status_attemptExpiresAt_idx" ON "EmailJob"("status", "attemptExpiresAt");

-- CreateIndex
CREATE INDEX "EmailJob_orderId_idx" ON "EmailJob"("orderId");

-- CreateIndex
CREATE INDEX "EmailJob_createdAt_idx" ON "EmailJob"("createdAt");

-- CreateIndex
CREATE INDEX "Order_confirmationStatus_confirmationExpiresAt_idx" ON "Order"("confirmationStatus", "confirmationExpiresAt");

-- CreateIndex
CREATE INDEX "Order_storefrontAccountId_createdAt_idx" ON "Order"("storefrontAccountId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_storefrontAccountId_fkey" FOREIGN KEY ("storefrontAccountId") REFERENCES "StorefrontAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorefrontSession" ADD CONSTRAINT "StorefrontSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StorefrontAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorefrontToken" ADD CONSTRAINT "StorefrontToken_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Prisma does not model the constraints, function and trigger below; it neither
-- manages nor drops them.

-- Existing orders: the ADD COLUMN above already gave every one of them
-- "confirmationStatus" = 'EXEMPT' (they were never asked to confirm) and left
-- the address, deadline, confirmation time and account NULL. Nothing about them
-- is marked as confirmed, and their snapshots, status and payment status are
-- untouched. Every rule below accepts them as they are.

-- The confirmation fields agree with each other and with the order's status.
-- An order waiting for its buyer is still PENDING and unpaid, so it cannot be
-- worked on, and one that ran out was cancelled (its stock put back).
ALTER TABLE "Order" ADD CONSTRAINT "Order_confirmation_state_check" CHECK (
  ("confirmationStatus" = 'EXEMPT'
    AND "confirmationEmail" IS NULL
    AND "confirmationExpiresAt" IS NULL
    AND "confirmedAt" IS NULL)
  OR ("confirmationStatus" = 'AWAITING_CONFIRMATION'
    AND "confirmationEmail" IS NOT NULL
    AND "confirmationExpiresAt" IS NOT NULL
    AND "confirmedAt" IS NULL
    AND "status" = 'PENDING'
    AND "paymentStatus" = 'PENDING')
  OR ("confirmationStatus" = 'CONFIRMED'
    AND "confirmationEmail" IS NOT NULL
    AND "confirmationExpiresAt" IS NOT NULL
    AND "confirmedAt" IS NOT NULL
    AND "confirmedAt" <= "confirmationExpiresAt")
  OR ("confirmationStatus" = 'EXPIRED'
    AND "confirmationEmail" IS NOT NULL
    AND "confirmationExpiresAt" IS NOT NULL
    AND "confirmedAt" IS NULL
    AND "status" = 'CANCELLED')
);

ALTER TABLE "Order" ADD CONSTRAINT "Order_confirmation_email_check" CHECK (
  "confirmationEmail" IS NULL
  OR ("confirmationEmail" <> '' AND "confirmationEmail" = lower(btrim("confirmationEmail")))
);

-- Historical and staff orders are never handed to a storefront account.
ALTER TABLE "Order" ADD CONSTRAINT "Order_storefront_account_check" CHECK (
  "storefrontAccountId" IS NULL OR "confirmationStatus" <> 'EXEMPT'
);

-- The address the confirmation went to is fixed once the order exists. With the
-- state check above this also fixes the exemption itself: an EXEMPT order can
-- never gain an address (so never needs or claims a confirmation), and an order
-- that needed one can never drop it to become EXEMPT.
CREATE FUNCTION "Order_confirmation_email_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."confirmationEmail" IS DISTINCT FROM OLD."confirmationEmail" THEN
    RAISE EXCEPTION 'Order.confirmationEmail cannot change once the order exists'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_confirmation_email_immutable"
BEFORE UPDATE OF "confirmationEmail" ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_confirmation_email_immutable"();

-- One account per address: stored trimmed and lower-cased, so the unique index
-- on "email" cannot hold "Ada@x.com" and "ada@x.com" side by side.
ALTER TABLE "StorefrontAccount" ADD CONSTRAINT "StorefrontAccount_email_check" CHECK (
  "email" <> '' AND "email" = lower(btrim("email"))
);
ALTER TABLE "StorefrontAccount" ADD CONSTRAINT "StorefrontAccount_password_hash_check" CHECK (
  "passwordHash" <> ''
);

ALTER TABLE "StorefrontToken" ADD CONSTRAINT "StorefrontToken_email_check" CHECK (
  "email" <> '' AND "email" = lower(btrim("email"))
);
ALTER TABLE "StorefrontToken" ADD CONSTRAINT "StorefrontToken_expiry_check" CHECK (
  "expiresAt" > "createdAt"
);

ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_recipient_check" CHECK (
  "recipient" <> '' AND "recipient" = lower(btrim("recipient"))
);
ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_attempts_check" CHECK (
  "maxAttempts" >= 1 AND "attempts" >= 0 AND "attempts" <= "maxAttempts"
);
-- Sent exactly when it has a sent time; a lease is a token and its expiry
-- together, and only a job still to be sent can hold one.
ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_state_check" CHECK (
  ("status" = 'SENT') = ("sentAt" IS NOT NULL)
  AND ("attemptToken" IS NULL) = ("attemptExpiresAt" IS NULL)
  AND ("status" = 'PENDING' OR "attemptToken" IS NULL)
);
-- An order confirmation is always about an order.
ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_order_check" CHECK (
  "type" <> 'ORDER_CONFIRMATION' OR "orderId" IS NOT NULL
);

