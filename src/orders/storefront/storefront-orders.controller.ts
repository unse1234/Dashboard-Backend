import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PlaceOrderDto } from './dto/place-order.dto';
import type { StorefrontReceipt } from './storefront-order.mapper';
import { StorefrontOrdersService } from './storefront-orders.service';

const MINUTE_MS = 60_000;

// 8 to 100 characters that are safe in a header and in logs; a UUID fits.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Where a guest places an order. Public by design, so it is narrow: its own DTO
 * (no customer, amount, status, currency or card field exists to be sent), a
 * receipt projection of its own, and a tight rate limit. It does not expose the
 * dashboard's order routes, and there is deliberately no way to look an order up
 * by its reference: a guest who is unsure whether theirs went through retries it
 * with the same key.
 */
@Public()
@Controller('storefront')
export class StorefrontOrdersController {
  constructor(private readonly orders: StorefrontOrdersService) {}

  // A retry after a timeout counts, so this is not as low as it looks: a person
  // places one order, and perhaps retries it once or twice.
  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @Post('orders')
  place(
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: PlaceOrderDto,
  ): Promise<StorefrontReceipt> {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new BadRequestException(
        'Send an Idempotency-Key header of 8 to 100 letters, digits, "-" or "_" (a UUID works)',
      );
    }
    return this.orders.place(key, dto);
  }
}
