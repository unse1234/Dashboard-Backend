import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import {
  StorefrontCatalogReadinessController,
  StorefrontProductsController,
} from './storefront/storefront-products.controller';
import { StorefrontProductsService } from './storefront/storefront-products.service';

@Module({
  controllers: [
    ProductsController,
    CategoriesController,
    StorefrontProductsController,
    StorefrontCatalogReadinessController,
  ],
  providers: [ProductsService, StorefrontProductsService],
})
export class ProductsModule {}
