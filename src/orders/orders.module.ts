import { Module } from '@nestjs/common';
import { EmailOutboxModule } from '../email-outbox/email-outbox.module';
import { OrderExpiryService } from './order-expiry.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderConfirmationController } from './storefront/order-confirmation.controller';
import { OrderConfirmationService } from './storefront/order-confirmation.service';
import { OrderConfirmationSettings } from './storefront/order-confirmation.settings';
import { QuoteTokenService } from './storefront/quote-token.service';
import { StorefrontBagController } from './storefront/storefront-bag.controller';
import { StorefrontOrdersController } from './storefront/storefront-orders.controller';
import { StorefrontOrdersService } from './storefront/storefront-orders.service';
import { StorefrontPricingService } from './storefront/storefront-pricing.service';
import { StorefrontQuoteService } from './storefront/storefront-quote.service';

@Module({
  imports: [EmailOutboxModule],
  controllers: [
    OrdersController,
    StorefrontBagController,
    StorefrontOrdersController,
    OrderConfirmationController,
  ],
  providers: [
    OrdersService,
    OrderConfirmationSettings,
    OrderConfirmationService,
    OrderExpiryService,
    QuoteTokenService,
    StorefrontPricingService,
    StorefrontQuoteService,
    StorefrontOrdersService,
  ],
  // The scheduled run (src/scripts/run-jobs.ts) expires overdue orders; the
  // storefront accounts module reads whether accounts are on.
  exports: [OrderExpiryService, OrderConfirmationSettings],
})
export class OrdersModule {}
