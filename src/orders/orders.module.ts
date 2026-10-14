import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { QuoteTokenService } from './storefront/quote-token.service';
import { StorefrontBagController } from './storefront/storefront-bag.controller';
import { StorefrontOrdersController } from './storefront/storefront-orders.controller';
import { StorefrontOrdersService } from './storefront/storefront-orders.service';
import { StorefrontPricingService } from './storefront/storefront-pricing.service';
import { StorefrontQuoteService } from './storefront/storefront-quote.service';

@Module({
  controllers: [
    OrdersController,
    StorefrontBagController,
    StorefrontOrdersController,
  ],
  providers: [
    OrdersService,
    QuoteTokenService,
    StorefrontPricingService,
    StorefrontQuoteService,
    StorefrontOrdersService,
  ],
})
export class OrdersModule {}
