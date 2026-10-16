# PKR currency policy

All new sales use PKR. The shared product creation path (dashboard API and CSV
imports), development seed data, empty/nonempty bags, checkout quotes and new
orders use the same policy. Monetary calculations and rounding are unchanged.

## Migration

Migration `20261016090000_pkr_defaults` changes the `Product.currency` and
`Order.currency` database defaults to PKR. It contains no data updates: existing
prices, costs, order amounts, currencies and history remain unchanged. The USD
enum value is retained so historical records remain readable.

From `Backend/`, for each environment being deployed:

```sh
npx prisma generate
npx prisma migrate deploy
npm run build
```

Restart/redeploy the backend after applying the migration. No new environment
variables or packages are needed. Do not reset a development/production database
or rerun seed data to change currencies. Existing USD records are never converted
by this deployment.

## API behavior

- `POST /products`: omit `currency` to use PKR, or send `"currency":"PKR"`.
  Any other currency, including USD, returns standard `400` validation errors
  with `currency must be PKR`. CSV prices/costs are interpreted as PKR.
- `PATCH /products/:productId`: omitted currency retains the recorded currency.
  Only PKR is accepted when a currency is explicitly supplied. Moving a legacy
  USD product to PKR requires `price` and, if it has a recorded cost, `costPrice`.
  Supply actual PKR amounts (or explicitly clear an unknown cost with `null`).
  Sending just a currency is rejected rather than silently relabelling money.
- Dashboard product/order/customer reads still return original currencies and
  amounts. Historical orders and their payment/status changes stay in USD when
  that is their recorded currency. Customer spending stays grouped by currency.
- Public catalogue list/detail and stock/quote lookups include only active,
  nonarchived, positively priced PKR products. A legacy USD public product detail
  returns `404`; staff can find it in `/storefront/catalog-readiness` and reprice it.
- Every bag/checkout quote uses PKR. Stale USD bag lines are unavailable and
  contribute no amount; they may be removed. Adding one returns `409
  PRODUCT_UNAVAILABLE`; checkout with one returns `409 PRODUCT_UNAVAILABLE`
  with line issues and no quote token.
- Dashboard and storefront order placement both reject USD products, including
  currency observed during the atomic stock update. The transaction rolls back
  any stock changes on failure. Clients cannot choose an order currency.
- Old signed USD quotes cannot place new orders. A retry of an already placed
  historical order with its original idempotency key and request still returns
  that order; it does not create another sale or change its currency.

Example explicit repricing of a legacy product, using a verified ADMIN/STAFF
bearer token and the product version most recently read:

```http
PATCH /products/PRD-1001
Authorization: Bearer <accessToken>
Content-Type: application/json

{"version":3,"currency":"PKR","price":2800,"costPrice":560}
```

This records the existing price-change history events with their old/new
currencies. It applies the supplied values; it does not calculate an exchange rate.

An incomplete repricing request returns:

```json
{"statusCode":400,"message":"Changing currency requires an explicit price and costPrice when a cost is recorded","error":"Bad Request"}
```

Storefront arithmetic, charges and inventory rules are unchanged; the currency
eligibility checks prevent historical USD amounts from entering new PKR sales.

## Frontend handoff

New product forms can continue omitting currency: the backend now stores PKR.
Use the API's currency when showing saved product/order/customer records, since
historical USD data is preserved. API responses retain their existing shapes.
Legacy USD products need explicit PKR repricing before they appear in the shop.
Product image upload integration is a separate next step.
