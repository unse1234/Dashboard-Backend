import { generateToken, sha256 } from '../common/crypto.util';
import {
  Prisma,
  type StorefrontTokenPurpose,
} from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';

/**
 * Every storefront token says what it is for in its first characters, so a
 * token offered for the wrong purpose is refused before any lookup, and log
 * redaction can recognise one (see common/redact.ts).
 */
export const STOREFRONT_TOKEN_PREFIX: Record<StorefrontTokenPurpose, string> = {
  ORDER_CONFIRMATION: 'oc_',
  ACCOUNT_SETUP: 'as_',
  CHECKOUT_RECEIPT: 'cr_',
  PASSWORD_RESET: 'pr_',
};

// generateToken(): 32 random bytes as base64url, always 43 characters.
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

export interface StorefrontTokenRecord {
  id: string;
  purpose: StorefrontTokenPurpose;
  /** The order it belongs to; null only for PASSWORD_RESET (a CHECK says so). */
  orderId: string | null;
  /** The account it belongs to; set only for PASSWORD_RESET. */
  accountId: string | null;
  /** Lower-cased: the address the token was issued for. */
  email: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/** Why a token was not accepted; the API answers all of them alike. */
export type StorefrontTokenRefusal =
  | { status: 'invalid' }
  | { status: 'expired' | 'used'; record: StorefrontTokenRecord };

export type StorefrontTokenCheck =
  { status: 'valid'; record: StorefrontTokenRecord } | StorefrontTokenRefusal;

export type StorefrontTokenConsumption =
  | { status: 'consumed'; record: StorefrontTokenRecord }
  | StorefrontTokenRefusal;

/** A new token for `purpose`: 256 random bits behind the purpose's prefix. */
export function createStorefrontToken(purpose: StorefrontTokenPurpose): string {
  return `${STOREFRONT_TOKEN_PREFIX[purpose]}${generateToken()}`;
}

/**
 * What is stored for a token, or null when it cannot be a token for `purpose`
 * (wrong prefix, wrong length or characters, not a string). A fast hash is
 * right here: the input has 256 bits of entropy (passwords use Argon2).
 */
export function storefrontTokenHash(
  token: unknown,
  purpose: StorefrontTokenPurpose,
): string | null {
  const prefix = STOREFRONT_TOKEN_PREFIX[purpose];
  if (typeof token !== 'string' || !token.startsWith(prefix)) return null;
  if (!TOKEN_BODY.test(token.slice(prefix.length))) return null;
  return sha256(token);
}

/**
 * Records a token and returns it; only its hash is stored. Pass `token` to
 * record one that was created earlier (the outbox seals it before the row is
 * known to be new). Runs in the caller's transaction when given one, so the
 * token exists exactly when the caller's change does.
 *
 * A token belongs to an order, or (PASSWORD_RESET) to an account.
 */
export async function issueStorefrontToken(
  db: Db,
  input: {
    purpose: StorefrontTokenPurpose;
    email: string;
    expiresAt: Date;
    token?: string;
  } & ({ orderId: string } | { accountId: string }),
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = input.token ?? createStorefrontToken(input.purpose);
  const tokenHash = storefrontTokenHash(token, input.purpose);
  if (!tokenHash) {
    throw new Error(`Not a token for ${input.purpose}`);
  }
  const row = await db.storefrontToken.create({
    data: {
      purpose: input.purpose,
      tokenHash,
      ...('orderId' in input
        ? { orderId: input.orderId }
        : { accountId: input.accountId }),
      email: input.email,
      expiresAt: input.expiresAt,
    },
    select: { id: true, expiresAt: true },
  });
  return { id: row.id, token, expiresAt: row.expiresAt };
}

interface TokenRow extends StorefrontTokenRecord {
  live: boolean;
}

// Deadlines are compared with the database's clock, in UTC like every stored
// timestamp, so the app's clock cannot stretch or shorten one.
const NOW_UTC = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);

const RECORD_COLUMNS = Prisma.raw(
  `"id", "purpose", "orderId", "accountId", "email", "expiresAt", "usedAt", "createdAt"`,
);

const toRecord = (row: TokenRow): StorefrontTokenRecord => ({
  id: row.id,
  purpose: row.purpose,
  orderId: row.orderId,
  accountId: row.accountId,
  email: row.email,
  expiresAt: row.expiresAt,
  usedAt: row.usedAt,
  createdAt: row.createdAt,
});

/** Whether a token would be accepted now, without using it. */
export async function checkStorefrontToken(
  db: Db,
  token: unknown,
  purpose: StorefrontTokenPurpose,
): Promise<StorefrontTokenCheck> {
  const tokenHash = storefrontTokenHash(token, purpose);
  if (!tokenHash) return { status: 'invalid' };

  const [row] = await db.$queryRaw<TokenRow[]>`
    SELECT ${RECORD_COLUMNS}, ("expiresAt" > ${NOW_UTC}) AS "live"
    FROM "StorefrontToken"
    WHERE "tokenHash" = ${tokenHash}
      AND "purpose" = ${purpose}::"StorefrontTokenPurpose"`;
  if (!row) return { status: 'invalid' };
  const record = toRecord(row);
  if (record.usedAt) return { status: 'used', record };
  if (!row.live) return { status: 'expired', record };
  return { status: 'valid', record };
}

/**
 * Uses a token: one conditional UPDATE, so of any number of concurrent attempts
 * exactly one succeeds. Run it in the transaction that acts on the token, so a
 * rollback leaves the token unused.
 */
export async function consumeStorefrontToken(
  db: Db,
  token: unknown,
  purpose: StorefrontTokenPurpose,
): Promise<StorefrontTokenConsumption> {
  const tokenHash = storefrontTokenHash(token, purpose);
  if (!tokenHash) return { status: 'invalid' };

  const [row] = await db.$queryRaw<StorefrontTokenRecord[]>`
    UPDATE "StorefrontToken" SET "usedAt" = ${NOW_UTC}
    WHERE "tokenHash" = ${tokenHash}
      AND "purpose" = ${purpose}::"StorefrontTokenPurpose"
      AND "usedAt" IS NULL AND "expiresAt" > ${NOW_UTC}
    RETURNING ${RECORD_COLUMNS}`;
  if (row) return { status: 'consumed', record: row };

  const check = await checkStorefrontToken(db, token, purpose);
  // Unused and in time, yet not updated: only possible if it expired between
  // the two statements. Report it as what it now is.
  return check.status === 'valid'
    ? { status: 'expired', record: check.record }
    : check;
}

/**
 * Marks an order's (or an address's) unused tokens of one purpose as used, for
 * example the older account-setup tokens when a newer one is issued. Returns
 * how many were voided.
 */
export async function voidStorefrontTokens(
  db: Db,
  scope: {
    purpose: StorefrontTokenPurpose;
    orderId?: string;
    accountId?: string;
    email?: string;
    exceptId?: string;
  },
): Promise<number> {
  if (
    scope.orderId === undefined &&
    scope.accountId === undefined &&
    scope.email === undefined
  ) {
    throw new Error('Give an order, an account or an email to void tokens for');
  }
  const { count } = await db.storefrontToken.updateMany({
    where: {
      purpose: scope.purpose,
      usedAt: null,
      ...(scope.orderId !== undefined ? { orderId: scope.orderId } : {}),
      ...(scope.accountId !== undefined ? { accountId: scope.accountId } : {}),
      ...(scope.email !== undefined ? { email: scope.email } : {}),
      ...(scope.exceptId !== undefined ? { id: { not: scope.exceptId } } : {}),
    },
    data: { usedAt: new Date() },
  });
  return count;
}
