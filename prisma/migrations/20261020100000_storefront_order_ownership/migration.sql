-- Storefront order ownership: an order may belong to an account only when it
-- is CONFIRMED and the inbox that confirmed it is the account's. No existing
-- row changes. No code before this step owned an order outside these rules,
-- so existing rows pass the new ones.

-- DropIndex
DROP INDEX "Order_storefrontAccountId_createdAt_idx";

-- CreateIndex
CREATE INDEX "Order_storefrontAccountId_createdAt_number_idx" ON "Order"("storefrontAccountId", "createdAt" DESC, "number" DESC);

-- Raw objects (not modelled by Prisma).

-- Owned orders are confirmed ones. The old rule only kept EXEMPT orders out;
-- an order still awaiting confirmation (or expired) proves nothing either.
ALTER TABLE "Order" DROP CONSTRAINT "Order_storefront_account_check";
ALTER TABLE "Order" ADD CONSTRAINT "Order_storefront_account_check" CHECK (
  "storefrontAccountId" IS NULL OR "confirmationStatus" = 'CONFIRMED'
);

-- The owning account's email is the address that confirmed the order. Both
-- sides are immutable (confirmationEmail by its own trigger, the account's
-- email by the one below), so checking when ownership is set is enough. An
-- order that is not CONFIRMED is left to the CHECK above, which refuses it.
CREATE FUNCTION "Order_storefront_account_email_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."storefrontAccountId" IS NOT NULL
    AND NEW."confirmationStatus" = 'CONFIRMED'
    AND NOT EXISTS (
    SELECT 1 FROM "StorefrontAccount" a
    WHERE a."id" = NEW."storefrontAccountId"
      AND a."email" = NEW."confirmationEmail"
  ) THEN
    RAISE EXCEPTION 'An order belongs only to the account of the address that confirmed it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_storefront_account_email_check"
BEFORE INSERT OR UPDATE OF "storefrontAccountId" ON "Order"
FOR EACH ROW EXECUTE FUNCTION "Order_storefront_account_email_check"();

-- An account is for one proven address for good: its orders were proven by
-- that address, so the address cannot be swapped underneath them.
CREATE FUNCTION "StorefrontAccount_email_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."email" IS DISTINCT FROM OLD."email" THEN
    RAISE EXCEPTION 'StorefrontAccount.email cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "StorefrontAccount_email_immutable"
BEFORE UPDATE OF "email" ON "StorefrontAccount"
FOR EACH ROW EXECUTE FUNCTION "StorefrontAccount_email_immutable"();
