import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Param,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  MAX_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
} from '../uploads/image-validation';
import { ProductImageUploadGuard } from './product-image-upload.guard';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { parsePublicId } from '../common/public-id';
import { ArchiveProductsDto } from './dto/archive-products.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UploadProductImagesQueryDto } from './dto/upload-product-images-query.dto';
import { ProductNumberParam } from './product-id.param';
import type { ProductDto, ProductHistoryEntryDto } from './product.mapper';
import { ProductsService, type ProductPage } from './products.service';

// Both dashboard roles run the catalogue, as the sidebar shows; verified email
// is enforced globally. Archiving is narrowed to administrators below.
@Roles('ADMIN', 'STAFF')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() query: ListProductsQueryDto): Promise<ProductPage> {
    return this.products.list(query);
  }

  @Get(':productId')
  get(@ProductNumberParam() number: number): Promise<ProductDto> {
    return this.products.get(number);
  }

  @Get(':productId/images')
  images(@ProductNumberParam() number: number) {
    return this.products.images(number);
  }

  @Post(':productId/images')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(ProductImageUploadGuard)
  @UseInterceptors(
    FilesInterceptor('images', MAX_PRODUCT_IMAGES, {
      // Default memory storage never writes unvalidated temporary files.
      limits: {
        fileSize: MAX_IMAGE_BYTES,
        files: MAX_PRODUCT_IMAGES,
        fields: 0,
        parts: MAX_PRODUCT_IMAGES + 1,
        fieldNameSize: 32,
        fieldSize: 0,
      },
    }),
  )
  uploadImages(
    @CurrentUser() actor: AuthenticatedUser,
    @ProductNumberParam() number: number,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Query() query: UploadProductImagesQueryDto,
  ) {
    return this.products.uploadImages(
      actor,
      number,
      files ?? [],
      query.replaceImageId,
    );
  }

  @Delete(':productId/images/:imageId')
  deleteImage(
    @CurrentUser() actor: AuthenticatedUser,
    @ProductNumberParam() number: number,
    @Param('imageId') imageId: string,
  ) {
    return this.products.deleteImage(actor, number, imageId);
  }

  @Get(':productId/history')
  async history(
    @ProductNumberParam() number: number,
  ): Promise<{ data: ProductHistoryEntryDto[] }> {
    return { data: await this.products.history(number) };
  }

  @Post()
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateProductDto,
  ): Promise<ProductDto> {
    return this.products.create(actor, dto);
  }

  @Patch(':productId')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @ProductNumberParam() number: number,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductDto> {
    return this.products.update(actor, number, dto);
  }

  // "Delete" in the dashboard: products are hidden, never removed, because
  // orders refer to them.
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post('archive')
  archive(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: ArchiveProductsDto,
  ): Promise<{ archived: number }> {
    // The DTO has already checked every id, so each one parses.
    const numbers = [
      ...new Set(
        dto.productIds.map((id) => parsePublicId('PRD', id) as number),
      ),
    ];
    return this.products.archive(actor, numbers);
  }
}
