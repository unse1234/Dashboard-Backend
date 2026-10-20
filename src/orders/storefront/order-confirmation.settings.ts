import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';

/** How long a checkout receipt keeps answering after the confirmation deadline. */
export const CHECKOUT_RECEIPT_GRACE_MS = 24 * 60 * 60 * 1000;

/** Confirmation emails an order may ask for again, after the first one. */
export const MAX_CONFIRMATION_RESENDS = 3;

/** The least time between two confirmation emails for one order. */
export const CONFIRMATION_RESEND_COOLDOWN_MS = 60_000;

/** Orders one address may have waiting for confirmation at once. */
export const MAX_AWAITING_ORDERS_PER_EMAIL = 3;

/**
 * Whether storefront orders need email confirmation, for how long they wait,
 * and whether confirming one offers a storefront account. One injectable
 * value, read once, so the whole app (and a test that swaps it) agrees.
 */
@Injectable()
export class OrderConfirmationSettings {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly accountsEnabled: boolean;
  readonly accountSetupTtlMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.getOrThrow('ORDER_CONFIRMATION_ENABLED', {
      infer: true,
    });
    this.ttlMs =
      config.getOrThrow('ORDER_CONFIRMATION_TTL_MINUTES', { infer: true }) *
      60_000;
    this.accountsEnabled = config.getOrThrow('STOREFRONT_ACCOUNTS_ENABLED', {
      infer: true,
    });
    this.accountSetupTtlMs =
      config.getOrThrow('ACCOUNT_SETUP_TTL_MINUTES', { infer: true }) * 60_000;
  }
}
