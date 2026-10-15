import { createHmac, hkdfSync } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { safeEqual } from '../../common/crypto.util';
import type { Env } from '../../config/env.validation';
import type { Currency } from '../../generated/prisma/client';

/**
 * What a checkout quote promises, and what the order must still match when it
 * is placed. Amounts are exact decimal strings, never numbers.
 */
export interface QuoteClaims {
  currency: Currency;
  /** [product number, quantity], ordered by product number. */
  items: [number, number][];
  /** The unit price of each item, in the same order, as exact decimals. */
  unitPrices: string[];
  /** The destination data a charge could depend on. */
  destination: { country: string; region: string };
  subtotal: string;
  shipping: string;
  tax: string;
  discount: string;
  total: string;
}

interface Envelope extends QuoteClaims {
  /** Token format version. */
  v: 1;
  /** When it stops being accepted, in epoch seconds. */
  exp: number;
}

export type QuoteVerification =
  | { status: 'valid'; claims: QuoteClaims; expiresAt: Date }
  | { status: 'expired'; claims: QuoteClaims; expiresAt: Date }
  | { status: 'invalid' };

// A token for 100 lines is a few kilobytes; anything far beyond is not ours.
const MAX_TOKEN_LENGTH = 16_384;

/**
 * Issues and verifies the opaque, signed `quoteToken` a checkout quote returns.
 *
 * It is stateless: the claims travel inside the token, signed with HMAC-SHA256,
 * so nothing is stored and a quote creates no cart, customer or reservation.
 * The signing key is derived (HKDF) from the server's own secret under a label of
 * its own, so it is never the key that signs access tokens and it never leaves
 * the server. The client stores and echoes the token; it cannot make or change
 * one.
 */
@Injectable()
export class QuoteTokenService {
  private readonly key: Buffer;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    const secret = config.getOrThrow('JWT_ACCESS_SECRET', { infer: true });
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        secret,
        'ecom-dash',
        'storefront-checkout-quote/v1',
        32,
      ),
    );
    this.ttlSeconds =
      config.getOrThrow('QUOTE_TTL_MINUTES', { infer: true }) * 60;
  }

  issue(
    claims: QuoteClaims,
    now: Date = new Date(),
  ): { token: string; expiresAt: Date } {
    const exp = Math.floor(now.getTime() / 1000) + this.ttlSeconds;
    const envelope: Envelope = { v: 1, exp, ...claims };
    const body = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    return {
      token: `${body}.${this.sign(body)}`,
      expiresAt: new Date(exp * 1000),
    };
  }

  /**
   * Whether a token is one this server issued, unaltered, and whether it is
   * still within its lifetime. An expired token still returns its claims, so a
   * caller can tell "stale" from "forged".
   */
  verify(token: string, now: Date = new Date()): QuoteVerification {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
      return { status: 'invalid' };
    }
    const parts = token.split('.');
    if (parts.length !== 2) return { status: 'invalid' };
    const [body, signature] = parts;
    if (!safeEqual(signature, this.sign(body))) return { status: 'invalid' };

    let envelope: Envelope;
    try {
      envelope = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as Envelope;
    } catch {
      return { status: 'invalid' };
    }
    if (!isEnvelope(envelope)) return { status: 'invalid' };

    // Only the claims leave this method, never the envelope's own fields.
    const claims: QuoteClaims = {
      currency: envelope.currency,
      items: envelope.items,
      unitPrices: envelope.unitPrices,
      destination: {
        country: envelope.destination.country,
        region: envelope.destination.region,
      },
      subtotal: envelope.subtotal,
      shipping: envelope.shipping,
      tax: envelope.tax,
      discount: envelope.discount,
      total: envelope.total,
    };
    const expiresAt = new Date(envelope.exp * 1000);
    return {
      status: now.getTime() < expiresAt.getTime() ? 'valid' : 'expired',
      claims,
      expiresAt,
    };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** The signature proves we wrote it; this guards against a version we did not. */
function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  const destination = e.destination as Record<string, unknown> | undefined;
  return (
    e.v === 1 &&
    typeof e.exp === 'number' &&
    (e.currency === 'PKR' || e.currency === 'USD') &&
    Array.isArray(e.items) &&
    e.items.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        Number.isInteger(item[0]) &&
        Number.isInteger(item[1]),
    ) &&
    Array.isArray(e.unitPrices) &&
    e.unitPrices.length === e.items.length &&
    e.unitPrices.every(isString) &&
    typeof destination === 'object' &&
    destination !== null &&
    isString(destination.country) &&
    isString(destination.region) &&
    isString(e.subtotal) &&
    isString(e.shipping) &&
    isString(e.tax) &&
    isString(e.discount) &&
    isString(e.total)
  );
}
