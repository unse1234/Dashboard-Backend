import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { StorefrontListProductsQueryDto } from './dto/storefront-list-products-query.dto';
import type { StorefrontProductDto } from './storefront-product.mapper';
import { StorefrontProductNumberParam } from './storefront-product-id.param';
import {
  StorefrontProductsService,
  type CatalogReadinessDto,
  type StorefrontProductPage,
} from './storefront-products.service';

const MINUTE_MS = 60_000;

/**
 * The public catalogue: no sign-in, read-only, and only what a visitor may see.
 * The dashboard's own product routes stay behind authentication; this is a
 * separate controller with its own DTOs and projection, so neither can widen
 * the other by accident.
 */
@Public()
@Controller('storefront/products')
export class StorefrontProductsController {
  constructor(private readonly products: StorefrontProductsService) {}

  // Search-as-you-type is debounced by the client, but it is still a lot of
  // requests from one visitor: a roomier limit than the default 100.
  @Throttle({ default: { limit: 300, ttl: MINUTE_MS } })
  @Get()
  list(
    @Query() query: StorefrontListProductsQueryDto,
  ): Promise<StorefrontProductPage> {
    return this.products.list(query);
  }

  @Throttle({ default: { limit: 300, ttl: MINUTE_MS } })
  @Get(':productId')
  get(
    @StorefrontProductNumberParam() number: number | null,
  ): Promise<StorefrontProductDto> {
    return this.products.get(number);
  }
}

/** Staff-only: what the public catalogue is hiding, and why it matters. */
@Roles('ADMIN', 'STAFF')
@Controller('storefront/catalog-readiness')
export class StorefrontCatalogReadinessController {
  constructor(private readonly products: StorefrontProductsService) {}

  @Get()
  readiness(): Promise<CatalogReadinessDto> {
    return this.products.readiness();
  }
}
