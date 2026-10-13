# Ecom Dash Backend

NestJS 11 + TypeScript (strict, CommonJS) + Prisma 7 (PostgreSQL, `@prisma/adapter-pg`).
Authentication: short-lived JWT access tokens, rotating refresh sessions, Argon2id passwords.

## Setup

Use Node.js 24 LTS and npm. From this folder:

```powershell
npm ci
copy .env.example .env      # then fill in DATABASE_URL and JWT_ACCESS_SECRET
npx prisma generate         # the generated client (src/generated) is not committed
npx prisma migrate deploy   # apply migrations (use `migrate dev` while developing the schema)
npm run start:dev
```

Generate a JWT secret with
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
Startup fails with a list of every missing or invalid variable (see `.env.example`).

The API runs at `http://localhost:3001`; the dashboard (port 3000) is the only allowed
browser origin by default (`CORS_ORIGINS`).

### Create the first administrator

There is no public registration. The first admin is created once from the command line:

```powershell
npm run admin:create -- --email admin@example.com --name "Ada Admin"
```

No password is passed or stored anywhere: the account is created without one and a
set-password link is emailed. With `MAIL_TRANSPORT=console` (development) the link is printed
in the terminal. The command refuses to run while an active admin exists. Afterwards,
admins invite staff through `POST /users`.

## API

All routes require `Authorization: Bearer <accessToken>` unless marked public.
Errors use Nest's standard shape `{ statusCode, message, error }`.

| Method | Path | Access | Notes |
|---|---|---|---|
| POST | `/auth/login` | public, 5/min per IP+email | `{ email, password }` → `{ accessToken, tokenType, expiresIn, user }` + refresh cookie |
| POST | `/auth/refresh` | public + CSRF headers | Rotates the refresh cookie; returns a new access token |
| POST | `/auth/logout` | public + CSRF headers | Revokes the session, clears the cookie, `204` |
| GET | `/auth/me` | any signed-in user | |
| PATCH | `/auth/change-password` | signed in | `{ currentPassword, newPassword }`; revokes other sessions, `204` |
| POST | `/auth/forgot-password` | public, 3/min | `{ email }` → always `202` with a generic message |
| POST | `/auth/reset-password` | public | `{ token, password }`; revokes all sessions. Also accepts invitation tokens |
| POST | `/auth/verify-email` | public | `{ token }` |
| POST | `/auth/resend-verification` | signed in | `202`; no-op if already verified |
| GET | `/auth/sessions` | signed in | Active sessions, `current` flags yours |
| DELETE | `/auth/sessions/:id` | signed in | Own sessions only (otherwise `404`), `204` |
| POST | `/users` | ADMIN | `{ name, email, role? }` → invitation email; `409` on duplicate email |
| GET | `/users/me` | any signed-in user, verified email | Own profile (same body as `/auth/me`) |
| GET | `/users` | ADMIN | `?page=1&pageSize=20&search&role&isActive` (`pageSize` ≤ 100; `search` matches name or email, case-insensitive; newest first) → `{ data, meta: { page, pageSize, total, totalPages } }` |
| GET | `/users/:id` | ADMIN | `404` if unknown, `400` if `:id` is not a UUID |
| PATCH | `/users/me` | any signed-in user, verified email | `{ name }` only; every other field is rejected with `400` |
| PATCH | `/users/:id` | ADMIN | `{ name?, role?, isActive? }`; not on yourself; the last admin is protected. Kept for compatibility: prefer the two focused routes below |
| PATCH | `/users/:id/active` | ADMIN | `{ isActive: boolean }`; not on yourself; the last active admin is protected. Deactivating revokes all of the user's sessions |
| PATCH | `/users/:id/role` | ADMIN | `{ role: "ADMIN" \| "STAFF" }`; not on yourself; the last active admin is protected. Applies to the user's existing tokens immediately |
| DELETE | `/users/:id` | ADMIN | Soft delete, `204`; not yourself; the last active admin is protected |
| GET | `/customers` | ADMIN, STAFF | `?page=1&pageSize=20&search&sortBy&sortOrder` (`pageSize` ≤ 100; `search` matches name, email or phone, case-insensitive, or a customer id such as `CUS-1001` or `1001`; `sortBy` is `id`, `name`, `email`, `totalOrders`, `totalSpent` or `joinedAt`, `sortOrder` is `asc` (default) or `desc`; newest first without `sortBy`) → `{ data, meta: { page, pageSize, total, totalPages } }` |
| GET | `/customers/:customerId` | ADMIN, STAFF | `{ customer, addresses, recentOrders }` (the 3 latest orders); `404` if unknown, `400` if `:customerId` is not like `CUS-1001` |
| GET | `/categories` | ADMIN, STAFF | `{ data: [{ id, name }] }`, by name |
| GET | `/products` | ADMIN, STAFF | `?page=1&pageSize=20&search&categoryId&status` (`pageSize` ≤ 100; `search` matches name or SKU, case-insensitive, or a product id such as `PRD-1001` or `1001`; `categoryId` is a category uuid; `status` is `ACTIVE`, `INACTIVE` or `OUT_OF_STOCK`; newest first) → `{ data, meta: { page, pageSize, total, totalPages } }`. Archived products are never listed |
| GET | `/products/:productId` | ADMIN, STAFF | One product; `404` if unknown or archived, `400` if `:productId` is not like `PRD-1001` |
| GET | `/products/:productId/history` | ADMIN, STAFF | `{ data: [{ id, change, occurredAt, actor }] }`, newest first, at most 50; `actor` is `null` for automatic changes |
| POST | `/products` | ADMIN, STAFF | `{ name, sku, categoryId, price, currency?, subtitle?, brand?, description?, imageUrl?, galleryUrls?, status?, costPrice?, stock? }` → `201`; `409` if the SKU is taken (any case, archived products included), `400` for an unknown category |
| PATCH | `/products/:productId` | ADMIN, STAFF | `{ version, ...fields }`; `version` is the one the editor loaded. Only fields that differ are written. `409` when the product changed since that version, or the SKU is taken. `subtitle`, `brand`, `description`, `imageUrl` and `costPrice` can be cleared with `null`, `galleryUrls` with `[]` |
| POST | `/products/archive` | ADMIN | `{ productIds: ["PRD-1001", ...] }` (1–100) → `200 { archived }`, the number archived by this call; unknown or already archived ids are skipped, so repeating it is harmless |
| GET | `/orders` | ADMIN, STAFF | `?page=1&pageSize=20&search&status&paymentStatus&customerId&sortBy&sortOrder` (`pageSize` ≤ 100; `search` matches the customer's name or email, case-insensitive, or an order id such as `ORD-10001` or `10001`; `status` is `PENDING`, `PROCESSING`, `SHIPPED`, `DELIVERED` or `CANCELLED`; `paymentStatus` is `PENDING`, `PAID` or `REFUNDED`; `customerId` is like `CUS-1001`; `sortBy` is `id`, `customer`, `createdAt`, `itemCount`, `total`, `paymentStatus` or `status`, `sortOrder` is `asc` (default) or `desc`; newest first without `sortBy`) → `{ data, meta: { page, pageSize, total, totalPages } }` |
| GET | `/orders/:orderId` | ADMIN, STAFF | The order with its lines, amounts and address snapshots; `404` if unknown, `400` if `:orderId` is not like `ORD-10001` |
| POST | `/orders` | ADMIN | Places an order. Needs an `Idempotency-Key` header. `{ customerId, items: [{ productId, quantity }], shippingAddress, billingAddress?, shipping?, discount?, tax?, paymentStatus? }` → `201` with the order. Prices come from the products, never from the request. `409` when there is not enough stock (nothing is taken) or the key was used for a different order |
| PATCH | `/orders/:orderId/status` | ADMIN, STAFF | `{ status }`. Moves along the lifecycle below; `409` with the reason otherwise. Asking for the status it already has is a no-op `200`. Cancelling returns the stock |
| PATCH | `/orders/:orderId/payment-status` | ADMIN, STAFF | `{ paymentStatus: "PAID" }` records that the payment arrived; repeating it is harmless; `409` for a cancelled order |
| GET | `/storefront/products` | public | `?page=1&pageSize=20&search&categoryId&sort` (`page` ≤ 10000, `pageSize` ≤ 100; `search` matches name, subtitle or brand, case-insensitive, `%` and `_` literal; `sort` is `newest` (default), `price_asc`, `price_desc` or `name`, each with a stable tie-break) → `{ data, meta: { page, pageSize, total, totalPages } }`. Any other parameter is `400` |
| GET | `/storefront/products/:productId` | public | One visible product. Unknown, malformed, switched-off, archived and not-priced-in-PKR ids are the same `404` |
| GET | `/storefront/catalog-readiness` | ADMIN, STAFF | `{ currency, eligible, excludedCount, excluded: [{ id, name, currency, price }] }`: the active products the storefront hides because they are not priced in PKR (first 100) |

Unverified users can sign in and use the `/auth/*` account routes; everything else
(`/users`, `/customers`, `/products`, `/categories`, `/orders`) requires a verified email. Passwords: 12–128 characters with a
lowercase letter, an uppercase letter and a number.

### How the frontend must use it

- Keep the access token **in memory** (never `localStorage`). It lasts 15 minutes.
- The refresh token is an HttpOnly cookie scoped to `/auth`; JavaScript cannot read it.
- Call `/auth/login`, `/auth/refresh` and `/auth/logout` with `credentials: "include"` and the
  header `X-CSRF-Protection: 1`. The request must come from an origin listed in `CORS_ORIGINS`
  (non-browser clients such as Postman must send an `Origin` header themselves).
- On a `401` from a normal request, call `/auth/refresh` once and retry. If `/auth/refresh`
  itself returns `401`, send the user to the login page. Several tabs refreshing at the same
  instant may get a `401` without losing the session (the cookie was already rotated); retry
  once before logging out.
- Email links point at the dashboard: `FRONTEND_URL/reset-password?token=…` (password reset
  and invitations) and `FRONTEND_URL/verify-email?token=…`. Those pages must exist in the
  frontend and post the token to the API. Set `Referrer-Policy: no-referrer` on them.

### The public catalogue

`/storefront/products` needs no sign-in and is read-only. It is a separate controller with its own
DTOs and projection; the dashboard's `/products` routes stay behind authentication.

- **What is visible.** A product that is `ACTIVE`, not archived, priced in **PKR** and with a price
  above zero. Sold-out products are listed, with `inStock: false`. A product priced in another
  currency is never shown under a PKR label and never converted: reprice it (`PATCH /products/:id`
  with `currency: "PKR"` and the new `price`) to publish it. `/storefront/catalog-readiness` lists
  what is being held back.
- **What is returned.** `id`, `name`, `subtitle`, `description`, `brand`, `category { id, name }`,
  `price`, `currency`, `image { url, alt }` (`null` without one), `gallery` and `inStock`. Never the
  internal id, SKU, cost price, version, exact stock or history. The client sends no visibility or
  status filter; there is none to send.
- **Work happens on the server.** Search, category filter, sort and pagination are one database
  query; the client renders the page it is given and its `meta`.
- **Limits.** 300 requests a minute per client address on the two public reads.

### Deactivating and deleting users

- **Deactivate** (`isActive: false`): sign-in and refresh stop working, and every session of
  that user is revoked in the same transaction, so their access tokens fail on the next request.
  **Reactivating** does not bring old sessions back: it revokes any that exist, and the user
  signs in again.
- **Delete** is a soft delete (`User.deletedAt`). The row is never removed, so anything that
  references a user (orders, audit trails, ...) stays intact. A deleted user is also inactive
  (a database `CHECK` guarantees it), has their sessions revoked and their unused email links
  voided, and disappears from `/users` (`404`). Their email address stays reserved, so it
  cannot be invited again. Purging or restoring deleted accounts is not implemented.
- Role, status and delete changes are serialized with a database lock, and the caller is
  re-checked as an active admin inside it, so concurrent requests can never leave the system
  without an active admin.

> **Deploying:** migration `20261009120000_user_soft_delete` adds the nullable `User.deletedAt`
> column. Run `npx prisma migrate deploy` against each environment **before** starting this
> version; the code selects that column.

### Customers

Customers are storefront shoppers, not dashboard users: they have their own `Customer` table,
never sign in here, and the API is read-only. Responses use public ids only (`CUS-<number>`,
`ORD-<number>`); internal uuids are never returned. Enums are sent as stored (`SHIPPING`,
`DELIVERED`, ...). Amounts are numbers in USD, stored as `NUMERIC(12,2)`.

Statistics are computed from the orders on every read: `totalOrders` counts every order,
cancelled ones included; `totalSpent` sums the totals of orders that were **not** cancelled;
`lastOrderAt` is the latest order of any status, or `null`.

Orders keep snapshots of the customer, the addresses and the products as they were when placed.
The database enforces non-negative amounts, `total = subtotal + shipping - discount + tax`,
line `total = quantity × unitPrice`, one default address per customer and type, and that a
customer with orders cannot be deleted.

There is no storefront yet, so data comes from the dev seed (see Commands).

> **Deploying:** migration `20261009130000_customers_and_orders` only adds tables. Deploy it
> after `20261009120000_user_soft_delete`.

### Products

A product is one sellable unit: one SKU, one price and one stock count (there are no variants).
Responses use the public id `PRD-<number>`; internal uuids are never returned. Prices are
numbers in the product's `currency` (`USD` or `PKR`) with at most two decimals, stored as
`NUMERIC(12,2)`. Categories are seeded by a
migration; there is no category management yet.

- **Status.** A product is `ACTIVE` or `INACTIVE`. "Out of stock" is not stored: it is an
  active product whose stock is 0, so it can never drift from the stock.
- **Archive, not delete.** The dashboard's "Delete" archives: the product disappears from every
  products endpoint (`404`), but is never removed, because orders refer to it. The SKU of an
  archived product stays reserved, so a SKU is never reassigned. Orders keep their own snapshot
  of the product's name, SKU and price, so archiving or editing a product never rewrites them.
- **Concurrent edits.** Every write, including stock moved by an order, increments `version`.
  `PATCH` must send the version it loaded and gets `409` if the product has changed since, so a
  stale form can never overwrite a newer stock level. A save that changes nothing is
  acknowledged without a new version.
- **History.** Each change is recorded in the same transaction as the change, with who made it
  (`null`, shown as "System", for automatic changes), and phrased for the History tab.
- **Currency.** Every product has a `currency` (`USD` by default; existing products are USD).
  Changing it relabels the price, it never converts it, so send the new prices with it. A
  currency change is recorded in the history as a price change.
- **Storefront fields.** `subtitle` (up to 160 characters), `imageUrl` and `galleryUrls` (up to
  10, in display order, no repeats). An image is an `http(s)` URL or a path starting with `/`;
  `javascript:`, `data:` and `//host` references are refused.
- **Database guarantees.** Stock is never negative, prices are never negative, and SKUs are
  unique ignoring case.

> **Deploying:** migration `20261013100000_product_storefront_metadata` adds a `Currency` enum
> and four columns to `Product` (currency defaulting to `USD`, subtitle, image, gallery); it
> cannot fail on existing data. Deploy it after `20261012120000_import_jobs`.
>
> **Deploying:** migration `20261012100000_products_and_inventory` adds tables, one nullable
> column and foreign key on `OrderItem` (existing lines keep `NULL`), and inserts the six
> default categories. Deploy it after `20261009130000_customers_and_orders`.

### Orders

Orders keep **snapshots** of the customer, both addresses and every line (product id, name,
SKU and unit price) as they were when the order was placed, so an order reads the same
whatever later happens to the customer or the products. Only its status and payment status
ever change afterwards. Amounts are `NUMERIC(12,2)` in the order's `currency`, computed with
exact decimals. The currency is the one its products are priced in (taken in the same statement
that takes the stock); an order that mixes currencies is refused with `400` and takes nothing.
Nothing is converted between currencies. Orders that predate currencies are `USD`.

**Payment method.** `paymentMethod` is `null` (legacy or unspecified) or `COD`. An order without
a method must be paid before it ships. A `COD` order may be `SHIPPED` while its payment is still
`PENDING`, since the cash is collected on delivery; `DELIVERED` always requires `PAID`. The
database enforces this as well as the API.

**Lifecycle.** Forward only; shipping may skip `PROCESSING`; `DELIVERED` and `CANCELLED` are final.

| From | May become |
|---|---|
| `PENDING` | `PROCESSING`, `SHIPPED`, `CANCELLED` |
| `PROCESSING` | `SHIPPED`, `CANCELLED` |
| `SHIPPED` | `DELIVERED` |
| `DELIVERED`, `CANCELLED` | nothing |

An order can only be `SHIPPED` or `DELIVERED` once its payment is `PAID`. Cancelling an order
that was `PAID` records the payment as `REFUNDED` (the refund itself is made outside the
dashboard; returns and refunds as flows are not implemented). The database enforces which
statuses and payment statuses go together. Every change is recorded in `OrderEvent` with who
made it.

**Stock.** Placing an order takes its units from the products' stock in the same transaction
that creates it, and cancelling it puts them back. There is no reservation step: nothing here
takes payment, so an unpaid order simply holds its stock until it is cancelled.

- The check and the change are one conditional `UPDATE ... WHERE stock >= quantity`, so two
  orders for the last unit cannot both succeed: the second waits for the first's row lock, finds
  no stock left, and is refused with `409` having taken nothing. The `CHECK (stock >= 0)` on the
  column is the backstop.
- Products are locked in a fixed order, so orders over overlapping products cannot deadlock.
- Every status change is a compare-and-set on the status the rules were checked against. Of
  several simultaneous cancellations exactly one changes the order and returns the stock; the
  others find it cancelled and are acknowledged with nothing done twice.
- Stock moved by an order bumps the product's `version` and appears in its history as "System".

**Retrying.** `POST /orders` requires an `Idempotency-Key` header (8 to 100 letters, digits,
`-` or `_`; a UUID works). The same key with the same request returns the order already placed
(still `201`), with no second deduction, however many times and however concurrently it is
sent. The same key with a different request is refused with `409`. Generate one key per order.

There is no dashboard screen that places orders: `POST /orders` is for a storefront or a
script, and is administrators-only until a storefront has credentials of its own. A browser
client calling it cross-origin would need `Idempotency-Key` added to the CORS allowed headers.

> **Deploying:** migration `20261012110000_order_lifecycle` adds columns with defaults and
> backfills `itemCount`, then adds a CHECK that the status and payment status go together. It
> **fails if existing orders break that rule**, so check first:
>
> ```sql
> SELECT count(*) FROM "Order" WHERE NOT (
>   ("status" IN ('SHIPPED','DELIVERED') AND "paymentStatus" = 'PAID')
>   OR ("status" = 'CANCELLED' AND "paymentStatus" IN ('PENDING','REFUNDED'))
>   OR ("status" IN ('PENDING','PROCESSING') AND "paymentStatus" IN ('PENDING','PAID')));
> ```
>
> Deploy it after `20261012100000_products_and_inventory`.

> **Deploying:** migration `20261013110000_order_currency_and_cod` adds `currency` (default
> `USD`) and a nullable `paymentMethod` to `Order`, and replaces the CHECK above with one that
> additionally allows a shipped `COD` order with a pending payment. Every row the old rule
> accepted satisfies the new one, so it cannot fail on existing data. Deploy it after
> `20261013100000_product_storefront_metadata`.

## Product CSV imports

`ADMIN` and `STAFF` can validate a UTF-8 product CSV at `POST /imports/preview` and
confirm a valid preview at `POST /imports/:jobId/confirm`. Download the header-only
template from `GET /imports/templates/products`. Files are limited to 10 MiB and
250 rows. Product creation and `CREATED` audit events share one transaction: a
failed row or a catalogue change prevents all writes. The job stores a bounded
preview for 15 minutes, error reports for seven days, and history for 90 days.
Only the initiating user can confirm; staff see their own jobs and admins can
inspect all jobs. The API accepts CSV only; spreadsheets are unsupported.

Deploy `20261012120000_import_jobs` before enabling the dashboard workflow.
Schedule `npm run imports:cleanup` daily. Each pass recovers up to 100 interrupted
attempts, removes expired previews and reports, and deletes up to 1,000 old jobs.
Run it more frequently if imports exceed those daily bounds. The command reads
the normal validated backend environment and should run against the same database
as the API.

## Security model

- Passwords: Argon2id. Unknown accounts, wrong passwords, disabled accounts and invited
  accounts without a password all produce the same `401` and cost the same time.
- Access tokens: HS256, issuer/audience/algorithm pinned. Every request also checks that the
  session is live and the user active, so logout, revocation, deactivation and role changes
  apply immediately.
- Refresh tokens: 256-bit random, only a SHA-256 hash is stored. Each use issues a new one.
  Presenting an old one again (outside a 30-second grace window for concurrent tabs) revokes
  the session.
- Reset, invitation and verification tokens: 256-bit random, hashed at rest, single use,
  expiring (30 min / 72 h / 24 h by default). Responses never contain them.
- CSRF: cookie endpoints require an allowed `Origin`/`Referer` plus the custom header; the
  cookie is SameSite and path-scoped.
- Rate limiting on credential endpoints, helmet headers, strict validation
  (`whitelist` + `forbidNonWhitelisted`), `Cache-Control: no-store`.

## Email

`MAIL_TRANSPORT=console` prints messages (development only; production refuses to start with
it). `MAIL_TRANSPORT=smtp` sends through any SMTP provider via nodemailer using `SMTP_HOST`,
`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. The SMTP path has not been
exercised against a real provider (no credentials were available); test it with your provider
or a local catcher such as Mailpit before relying on it.

## Commands

- `npm run build` — compile to `dist/` (run `npx prisma generate` first).
- `npm run start:prod` — run the compiled app.
- `npm run lint` / `npm run format`
- `npm test` — unit tests.
- `npm run test:e2e` — HTTP + database integration tests (see below).
- `npm run admin:create -- --email … --name …` — bootstrap the first admin.
- `npm run imports:cleanup` — remove expired import data and recover interrupted jobs.
- `npm run seed:dev -- --confirm [--reset]` — a sample catalogue, customers, addresses and
  orders (order lines refer to the catalogue's products). It never reads `.env`: set
  `DATABASE_URL` explicitly to a development or test database. It refuses `NODE_ENV=production`,
  does nothing without `--confirm`, and refuses a database that already has customers or
  products unless `--reset` (which empties the product, customer and order tables first).

## Testing

Unit tests need nothing. The e2e tests use a real PostgreSQL database that **must** be named
`*_test`; they refuse to run otherwise. Create `.env.test` (git-ignored) containing only:

```
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/dashboard_db_test?schema=public"
```

Create that database once (`CREATE DATABASE dashboard_db_test;`). Migrations are applied
automatically before the suite and tables are cleared between tests. Jest runs with
`--experimental-vm-modules` (already in the npm scripts) because `@nestjs/config` and
`@nestjs/jwt` are ESM-only.

## Performance

Measured on a local PostgreSQL 18 with 5,000 customers, 5,000 products, 50,000 orders and
100,000 order lines, through the compiled server (milliseconds, 15 requests each):

| Request | p50 | p95 |
|---|---|---|
| Orders, newest first | 33 | 43 |
| Orders, status and payment filter | 19 | 23 |
| Orders, sort by total / by customer | 84 / 106 | 105 / 125 |
| Orders, last page (offset 50,000) | 133 | 308 |
| Orders, search by name, email or id | 200–235 | 260–490 |
| One order with its lines | 8 | 30 |
| Products, any list, filter or search | 9–20 | 11–26 |
| Customers by total spent (existing) | 121 | 154 |

Every list is one `count` and one page query; nothing queries per row. The one slow case is
text search (`ILIKE '%term%'`), which cannot use a plain index and scans the table. That is
acceptable for a back office at this size, and it is not worth requiring an extension before it
is needed. **When order search gets slow** (tens of thousands of orders), add trigram indexes in a
migration. Prisma does not model them, so write the SQL by hand, like the other raw objects:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Order_customerName_trgm" ON "Order" USING gin ("customerName" gin_trgm_ops);
CREATE INDEX "Order_customerEmail_trgm" ON "Order" USING gin ("customerEmail" gin_trgm_ops);
```

On the same data this took the three search cases to 7–19 ms (p95 21 ms), with the planner
combining the trigram indexes and the order-number index. The same indexes apply to
`Product("name", "sku")` and `Customer("name", "email", "phone")` if those grow. If sorting
customers by orders or spend gets slow, the other path is storing the three statistics on
`Customer` and keeping them in the order transactions.

## Deployment notes

- Behind a reverse proxy set `TRUST_PROXY` to the number of proxies so client IPs (rate
  limiting, session list) are correct, and terminate TLS there.
- Production requires `COOKIE_SECURE=true`, `MAIL_TRANSPORT=smtp`, an `https` `FRONTEND_URL`
  and `RATE_LIMIT_ENABLED=true`; startup fails otherwise. If the dashboard and API are on
  different sites, use `COOKIE_SAMESITE=none` (requires secure cookies) or serve both under one
  registrable domain and keep `strict`.
- Run `npx prisma migrate deploy` on release, never `migrate dev`.
- Rate-limit counters are in memory (per process). With several instances, use a shared store.
- Expired sessions and tokens are ignored but not deleted; schedule a periodic cleanup
  (`DELETE … WHERE "expiresAt" < now() - interval '30 days'`).
- Refresh sessions slide (each refresh extends them by `REFRESH_TOKEN_TTL_DAYS`); there is no
  absolute maximum session age.

## Structure

- `src/main.ts`, `src/app.setup.ts` — startup; shared HTTP config (helmet, CORS, pipes, proxy).
- `src/config/` — environment validation.
- `src/prisma/` — global `PrismaService` (driver adapter, lifecycle).
- `src/auth/` — login, sessions, tokens, password recovery, verification.
- `src/users/` — admin user management and invitations.
- `src/customers/` — read-only customers list and details.
- `src/products/` — categories and the product catalogue (list, details, history, create, edit, archive); `inventory.ts` takes and returns stock.
- `src/orders/` — orders: list, details, placing (idempotent, takes stock), status and payment changes.
- `src/mail/` — mail abstraction with console and SMTP transports.
- `src/common/` — guards, decorators, validators, crypto helpers, public ids, money.
- `src/scripts/create-admin.ts` — first-admin bootstrap. `src/scripts/seed-dev-data.ts` — dev seed.
- `prisma/` — schema and migrations. `test/` — e2e tests and helpers.
