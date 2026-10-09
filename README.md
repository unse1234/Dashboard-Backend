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

Unverified users can sign in and use the `/auth/*` account routes; everything else
(`/users`, `/customers`) requires a verified email. Passwords: 12–128 characters with a
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

> **Deploying:** migration `20261009130000_customers_and_orders` only adds tables. Deploy it
> after `20261009120000_user_soft_delete`.

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
- `src/mail/` — mail abstraction with console and SMTP transports.
- `src/common/` — guards, decorators, validators, crypto helpers.
- `src/scripts/create-admin.ts` — first-admin bootstrap.
- `prisma/` — schema and migrations. `test/` — e2e tests and helpers.
