# PKR currency policy

All new sales use PKR. The shared product creation path (dashboard API and CSV
imports), development seed data, empty/nonempty bags, checkout quotes and new
orders use the same policy. Monetary calculations and rounding are unchanged.

All existing product amounts have been confirmed to be PKR amounts stored with
incorrect USD currency labels. The catalogue correction below changes those
labels without calculating an exchange rate. Historical orders stay unchanged.

## Migration

Migration `20261016090000_pkr_defaults` changes the `Product.currency` and
`Order.currency` database defaults to PKR. It contains no data updates: existing
prices, costs, order amounts, currencies and history remain unchanged. The USD
enum value is retained so historical records remain readable.

Migration `20261016110000_product_currency_pkr` corrects **every USD product**, including
inactive and archived products, to PKR. Prices, costs, stock and image references
stay unchanged. Each corrected product's version increases by one, so a stale edit
cannot overwrite the correction, and the existing price history records the old
and new currency. Already-PKR products are unchanged. The correction and history
entries are one atomic SQL statement and rerunning it has no further effect.
It does not update orders, order lines, payment records or old history entries.

From `Backend/`, for each environment being deployed:

```sh
npx prisma generate
npx prisma migrate deploy
npm run build
```

Restart/redeploy the backend after applying the migration. No new environment
variables or packages are needed. Do not reset a development/production database
or rerun seed data to change currencies. Product labels are corrected by the
new migration; historical USD orders are never converted by this deployment.

## API behavior

- `POST /products`: omit `currency` to use PKR, or send `"currency":"PKR"`.
  Any other currency, including USD, returns standard `400` validation errors
  with `currency must be PKR`. CSV prices/costs are interpreted as PKR.
- `PATCH /products/:productId`: omitted currency retains the recorded currency.
  Only PKR is accepted when a currency is explicitly supplied. Moving a legacy
  USD product to PKR requires `price` and, if it has a recorded cost, `costPrice`.
  Supply actual PKR amounts (or explicitly clear an unknown cost with `null`).
  Sending just a currency is rejected rather than silently relabelling money.
- After migration, product reads return PKR with unchanged prices and costs.
  Historical orders and their payment/status changes stay in USD when
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

Product create and edit forms explicitly send PKR. The backend also enforces PKR
for new products and imports. Use the API's currency when showing saved
order/customer records, since historical USD orders are preserved. API responses
retain their existing shapes. After both migrations, active, nonarchived products
with a positive price are eligible for the PKR shop. Product and completed-import
mutations invalidate the frontend's existing public catalog query keys.

On Render, run `npx prisma migrate deploy` against the production database during
deployment (for example, in a pre-deploy command where supported, or alongside the
existing migration step), then start the newly built backend. A code deployment
alone does not execute SQL migrations. Rebuild/redeploy Vercel with
`NEXT_PUBLIC_API_URL=https://dashboard-backend-5pki.onrender.com`.
`PUBLIC_API_URL` only determines public image addresses; it does not affect prices.
No additional environment variables are required.

After deployment, check an affected product's authenticated `GET /products/:productId`
response for `currency: "PKR"` and its unchanged price. The public
`GET /storefront/products` response should include active, positively priced products;
the protected `GET /storefront/catalog-readiness` report identifies exclusions.
Archived, inactive and zero-price products remain hidden under existing rules.
