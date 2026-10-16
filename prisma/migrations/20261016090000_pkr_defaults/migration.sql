-- Defaults affect only new rows. Preserve USD on historical records and keep
-- the enum value so past orders, products and audit history remain readable.
ALTER TABLE "Product" ALTER COLUMN "currency" SET DEFAULT 'PKR'::"Currency";
ALTER TABLE "Order" ALTER COLUMN "currency" SET DEFAULT 'PKR'::"Currency";
