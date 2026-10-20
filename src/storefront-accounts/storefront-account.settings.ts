import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

/** How long an emailed account setup link works. */
export const SETUP_LINK_TTL_MS = 60 * 60_000;

/** How long a storefront password reset link works. */
export const STOREFRONT_PASSWORD_RESET_TTL_MS = 30 * 60_000;

/** The least time between two account emails of one kind to one address. */
export const ACCOUNT_EMAIL_COOLDOWN_MS = 60_000;

/** Account emails of one kind one address may be sent in a day. */
export const MAX_ACCOUNT_EMAILS_PER_DAY = 5;

/**
 * Storefront (shopper) session lifetimes, read once. Whether accounts are on
 * at all is OrderConfirmationSettings.accountsEnabled, which confirmation
 * reads too.
 */
@Injectable()
export class StorefrontSessionSettings {
  readonly accessTtlSeconds: number;
  readonly sessionTtlMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.accessTtlSeconds = config.getOrThrow('STOREFRONT_ACCESS_TTL_SECONDS', {
      infer: true,
    });
    this.sessionTtlMs =
      config.getOrThrow('STOREFRONT_SESSION_TTL_DAYS', { infer: true }) *
      24 *
      60 *
      60 *
      1000;
  }
}
