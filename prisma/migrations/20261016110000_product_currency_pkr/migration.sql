-- Product amounts were entered in PKR but earlier imports stored a USD label.
-- Correct that metadata without converting prices or touching order snapshots.
-- One statement keeps the correction and its existing price history atomic.
WITH corrected AS (
  UPDATE "Product"
  SET "currency" = 'PKR'::"Currency",
      "version" = "version" + 1,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "currency" = 'USD'::"Currency"
  RETURNING "id", "price", "costPrice"
)
INSERT INTO "ProductEvent" ("id", "productId", "type", "data", "createdAt")
SELECT gen_random_uuid()::text, "id", 'PRICE_CHANGED'::"ProductEventType",
       jsonb_build_object('field', 'price', 'from', "price", 'to', "price",
                          'fromCurrency', 'USD', 'currency', 'PKR'),
       CURRENT_TIMESTAMP
FROM corrected
UNION ALL
SELECT gen_random_uuid()::text, "id", 'PRICE_CHANGED'::"ProductEventType",
       jsonb_build_object('field', 'costPrice', 'from', "costPrice", 'to', "costPrice",
                          'fromCurrency', 'USD', 'currency', 'PKR'),
       CURRENT_TIMESTAMP
FROM corrected
WHERE "costPrice" IS NOT NULL;
