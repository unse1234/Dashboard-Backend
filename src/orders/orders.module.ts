import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { QuoteTokenService } from './storefront/quote-token.service';
import { StorefrontBagController } from './storefront/storefront-bag.controller';
import { StorefrontPricingService } from './storefront/storefront-pricing.service';
import { StorefrontQuoteService } from './storefront/storefront-quote.service';

@Module({
  controllers: [OrdersController, StorefrontBagController],
  providers: [
    OrdersService,
    QuoteTokenService,
    StorefrontPricingService,
    StorefrontQuoteService,
  ],
})
export class OrdersModule {}
