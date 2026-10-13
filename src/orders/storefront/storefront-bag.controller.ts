import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { BagQuoteDto, CheckoutQuoteDto } from './dto/bag-quote.dto';
import {
  StorefrontQuoteService,
  type BagQuoteResponse,
  type CheckoutQuoteResponse,
} from './storefront-quote.service';

const MINUTE_MS = 60_000;

/**
 * The guest's bag and checkout quotes. Public and stateless: the client keeps
 * the bag, the server prices it. There is no cart table and no session, and
 * nothing here reserves stock; both routes only compute and answer.
 */
@Public()
@Controller('storefront')
export class StorefrontBagController {
  constructor(private readonly quotes: StorefrontQuoteService) {}

  // Every click on + or - is one of these, so the limit is roomy.
  @Throttle({ default: { limit: 120, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('bag/quote')
  bag(@Body() dto: BagQuoteDto): Promise<BagQuoteResponse> {
    return this.quotes.quoteBag(dto);
  }

  @Throttle({ default: { limit: 60, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('checkout/quote')
  checkout(@Body() dto: CheckoutQuoteDto): Promise<CheckoutQuoteResponse> {
    return this.quotes.quoteCheckout(dto);
  }
}
