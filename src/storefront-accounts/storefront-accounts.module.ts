import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailOutboxModule } from '../email-outbox/email-outbox.module';
import { OrdersModule } from '../orders/orders.module';
import { StorefrontAccessTokenService } from './storefront-access-token.service';
import { StorefrontSessionSettings } from './storefront-account.settings';
import { StorefrontAccountOrdersService } from './storefront-account-orders.service';
import { StorefrontAccountRecoveryService } from './storefront-account-recovery.service';
import { StorefrontAccountsController } from './storefront-accounts.controller';
import { StorefrontAccountsService } from './storefront-accounts.service';
import {
  StorefrontAccountsEnabledGuard,
  StorefrontAuthGuard,
} from './storefront-auth.guard';
import { StorefrontRefreshCookieService } from './storefront-refresh-cookie.service';
import { StorefrontSessionsService } from './storefront-sessions.service';

/**
 * Storefront (shopper) accounts and their sessions. Reuses the staff password
 * hashing (Argon2id) and nothing else of staff authentication: its own token
 * key and audience, session table, cookie and guard.
 */
@Module({
  // AuthModule: PasswordService. OrdersModule: OrderConfirmationSettings, the
  // switch that turns accounts on.
  imports: [AuthModule, EmailOutboxModule, OrdersModule],
  controllers: [StorefrontAccountsController],
  providers: [
    StorefrontSessionSettings,
    StorefrontAccessTokenService,
    StorefrontSessionsService,
    StorefrontRefreshCookieService,
    StorefrontAccountsService,
    StorefrontAccountRecoveryService,
    StorefrontAccountOrdersService,
    StorefrontAccountsEnabledGuard,
    StorefrontAuthGuard,
  ],
})
export class StorefrontAccountsModule {}
