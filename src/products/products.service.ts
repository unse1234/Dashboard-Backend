import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { escapeLike } from '../common/like.util';
import { toDecimal } from '../common/money';
import { numberFromSearch } from '../common/public-id';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { MAX_PRODUCT_IMAGES } from '../uploads/image-validation';
import {
  IMAGE_LIMIT_MESSAGE,
  imageId,
  imageReferences,
  lockProductImages,
  normalizeImageChanges,
  toImageDtos,
  type ProductImageDto,
} from './product-images';
import type { CreateProductDto } from './dto/create-product.dto';
import { createProductInTransaction } from './product-create';
import type {
  ListProductsQueryDto,
  ProductStatusFilter,
} from './dto/list-products-query.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import { diffProduct, toEventRows } from './product-events';
import {
  productEventSelect,
  productSelect,
  toHistoryEntry,
  toProductDto,
  type ProductDto,
  type ProductHistoryEntryDto,
  type ProductRow,
} from './product.mapper';

/** How many of a product's latest changes the history lists. */
export const HISTORY_LIMIT = 50;

export const STALE_VERSION_MESSAGE =
  'This product was changed by someone else. Reload it and try again.';
export const SKU_TAKEN_MESSAGE = 'A product with this SKU already exists';

export interface ProductPage {
  data: ProductDto[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface ProductImagesResult {
  data: ProductImageDto[];
  product: ProductDto;
}

/** Which products a status filter means; the same derivation the screens use. */
function statusFilter(
  status: ProductStatusFilter | undefined,
): Prisma.ProductWhereInput {
  switch (status) {
    case 'ACTIVE':
      return { status: 'ACTIVE', stock: { gt: 0 } };
    case 'OUT_OF_STOCK':
      return { status: 'ACTIVE', stock: 0 };
    case 'INACTIVE':
      return { status: 'INACTIVE' };
    default:
      return {};
  }
}

/** Name or SKU contain the term (any case), or the term is the product's id. */
function searchFilter(search: string | undefined): Prisma.ProductWhereInput {
  if (!search) return {};
  const term = escapeLike(search);
  const number = numberFromSearch('PRD', search);
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { sku: { contains: term, mode: 'insensitive' } },
      ...(number === null ? [] : [{ number }]),
    ],
  };
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
  ) {}

  private toDto(row: ProductRow): ProductDto {
    return toProductDto(row, (reference) => this.uploads.publicUrl(reference));
  }

  async list(query: ListProductsQueryDto): Promise<ProductPage> {
    const where: Prisma.ProductWhereInput = {
      archivedAt: null,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...statusFilter(query.status),
      ...searchFilter(query.search),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        select: productSelect,
        // Newest first; the id breaks ties so that pages never overlap.
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      data: rows.map((row) => this.toDto(row)),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async get(number: number): Promise<ProductDto> {
    return this.toDto(await this.findActive(this.prisma, number));
  }

  /** The product's latest changes, newest first. */
  async history(number: number): Promise<ProductHistoryEntryDto[]> {
    const product = await this.prisma.product.findFirst({
      where: { number, archivedAt: null },
      select: {
        events: {
          select: productEventSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: HISTORY_LIMIT,
        },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product.events.map(toHistoryEntry);
  }

  async create(
    actor: AuthenticatedUser,
    dto: CreateProductDto,
  ): Promise<ProductDto> {
    normalizeImageChanges(dto, null, this.uploads);
    try {
      return await this.prisma.$transaction(async (tx) => {
        return this.toDto(await createProductInTransaction(tx, actor, dto));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(SKU_TAKEN_MESSAGE);
      }
      throw error;
    }
  }

  /**
   * Applies the fields that differ, provided the product is still at the version
   * the editor loaded. Two edits from the same version cannot both win: the
   * second one's conditional update matches no row once the first has bumped
   * the version, and it is answered with 409 instead of silently overwriting.
   */
  async update(
    actor: AuthenticatedUser,
    number: number,
    dto: UpdateProductDto,
  ): Promise<ProductDto> {
    if (!hasAnyField(dto)) throw new BadRequestException('No changes supplied');

    let removed: string[] = [];
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        if (dto.imageUrl !== undefined || dto.galleryUrls !== undefined)
          await lockProductImages(tx);
        const current = await this.findActive(tx, number);
        if (current.version !== dto.version) {
          throw new ConflictException(STALE_VERSION_MESSAGE);
        }

        if (
          dto.currency !== undefined &&
          dto.currency !== current.currency &&
          (dto.price === undefined ||
            (current.costPrice !== null && dto.costPrice === undefined))
        ) {
          throw new BadRequestException(
            'Changing currency requires an explicit price and costPrice when a cost is recorded',
          );
        }

        normalizeImageChanges(dto, current, this.uploads);

        const changes = changedFields(current, dto);
        // The form sends every field every time, so "nothing differs" is normal:
        // acknowledge it without bumping the version or writing history.
        if (Object.keys(changes).length === 0) return this.toDto(current);

        if (dto.categoryId !== undefined && 'categoryId' in changes) {
          await this.assertCategoryExists(tx, dto.categoryId);
        }

        const { count } = await tx.product.updateMany({
          where: {
            id: current.id,
            version: current.version,
            archivedAt: null,
          },
          data: { ...changes, version: { increment: 1 } },
        });
        if (count === 0) throw new ConflictException(STALE_VERSION_MESSAGE);

        const updated = await tx.product.findUniqueOrThrow({
          where: { id: current.id },
          select: productSelect,
        });
        await tx.productEvent.createMany({
          data: toEventRows(
            current.id,
            actor.id,
            diffProduct(current, updated),
          ),
        });
        removed = imageReferences(current).filter(
          (ref) => !imageReferences(updated).includes(ref),
        );
        return this.toDto(updated);
      });
      await this.uploads.cleanupUnreferenced(removed);
      return result;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(SKU_TAKEN_MESSAGE);
      }
      throw error;
    }
  }

  async images(number: number): Promise<{ data: ProductImageDto[] }> {
    return {
      data: toImageDtos(
        await this.findActive(this.prisma, number),
        this.uploads,
      ),
    };
  }

  async uploadImages(
    actor: AuthenticatedUser,
    number: number,
    files: Express.Multer.File[],
    replaceImageId?: string,
  ): Promise<ProductImagesResult> {
    this.uploads.validateBatch(files);
    if (replaceImageId && files.length !== 1)
      throw new BadRequestException(
        'Replacing an image requires exactly one file',
      );
    let saved: string[] = [];
    let removed: string[] = [];
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          await lockProductImages(tx);
          const current = await this.findActive(tx, number);
          const existing = imageReferences(current);
          const replacePosition = replaceImageId
            ? existing.findIndex((ref) => imageId(ref) === replaceImageId)
            : -1;
          if (replaceImageId && replacePosition === -1)
            throw new NotFoundException('Image not found');
          if (
            existing.length + files.length - (replaceImageId ? 1 : 0) >
            MAX_PRODUCT_IMAGES
          )
            throw new BadRequestException(IMAGE_LIMIT_MESSAGE);
          saved = await this.uploads.saveBatch(files);
          const next = [...existing];
          if (replacePosition >= 0)
            removed = next.splice(replacePosition, 1, ...saved);
          else next.push(...saved);
          const updated = await this.writeImages(tx, actor, current, next);
          return this.imageResult(updated);
        },
        { timeout: 30_000 },
      );
      await this.uploads.cleanupUnreferenced(removed);
      return result;
    } catch (error) {
      // Rollback precedes cleanup; reference checks also protect ambiguous commits.
      await this.uploads.cleanupUnreferenced(saved);
      throw error;
    }
  }

  async deleteImage(
    actor: AuthenticatedUser,
    number: number,
    id: string,
  ): Promise<ProductImagesResult> {
    let removed: string[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      await lockProductImages(tx);
      const current = await this.findActive(tx, number);
      const existing = imageReferences(current);
      removed = existing.filter((ref) => imageId(ref) === id);
      if (!removed.length) throw new NotFoundException('Image not found');
      const updated = await this.writeImages(
        tx,
        actor,
        current,
        existing.filter((ref) => imageId(ref) !== id),
      );
      return this.imageResult(updated);
    });
    // External refs are ignored and shared/archived references retain their file.
    await this.uploads.cleanupUnreferenced(removed);
    return result;
  }

  private imageResult(row: ProductRow): ProductImagesResult {
    return { data: toImageDtos(row, this.uploads), product: this.toDto(row) };
  }

  private async writeImages(
    db: Db,
    actor: AuthenticatedUser,
    current: ProductRow,
    references: string[],
  ): Promise<ProductRow> {
    const { count } = await db.product.updateMany({
      where: { id: current.id, version: current.version, archivedAt: null },
      data: {
        imageUrl: references[0] ?? null,
        galleryUrls: references.slice(1),
        version: { increment: 1 },
      },
    });
    if (!count) throw new ConflictException(STALE_VERSION_MESSAGE);
    const updated = await db.product.findUniqueOrThrow({
      where: { id: current.id },
      select: productSelect,
    });
    await db.productEvent.createMany({
      data: toEventRows(current.id, actor.id, diffProduct(current, updated)),
    });
    return updated;
  }

  /**
   * Hides products from the catalogue. Idempotent: unknown and already archived
   * products are skipped, and the result counts only those archived by this call.
   * Orders keep their own snapshot of an archived product.
   */
  archive(
    actor: AuthenticatedUser,
    numbers: number[],
  ): Promise<{ archived: number }> {
    return this.prisma.$transaction(async (tx) => {
      // The rows this statement changed are exactly the ones to record, even
      // if a concurrent request archives some of the same products.
      const archived = await tx.product.updateManyAndReturn({
        where: { number: { in: numbers }, archivedAt: null },
        data: { archivedAt: new Date(), version: { increment: 1 } },
        select: { id: true },
      });
      if (archived.length > 0) {
        await tx.productEvent.createMany({
          data: archived.flatMap(({ id }) =>
            toEventRows(id, actor.id, [{ type: 'ARCHIVED', data: {} }]),
          ),
        });
      }
      return { archived: archived.length };
    });
  }

  private async findActive(db: Db, number: number): Promise<ProductRow> {
    const product = await db.product.findFirst({
      where: { number, archivedAt: null },
      select: productSelect,
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async assertCategoryExists(
    db: Db,
    categoryId: string,
  ): Promise<void> {
    const category = await db.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new BadRequestException('Unknown category');
  }
}

const hasAnyField = (dto: UpdateProductDto) =>
  (
    [
      'name',
      'sku',
      'subtitle',
      'brand',
      'description',
      'imageUrl',
      'galleryUrls',
      'categoryId',
      'status',
      'price',
      'currency',
      'costPrice',
      'stock',
    ] as const
  ).some((field) => dto[field] !== undefined);

const sameAmount = (current: Prisma.Decimal | null, next: number | null) =>
  current === null || next === null
    ? current === null && next === null
    : current.equals(toDecimal(next));

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Only the fields that actually differ, so an untouched field is never written
 * and never appears in the history. `undefined` means "leave as it is"; `null`
 * on the optional ones means "clear".
 */
function changedFields(
  current: ProductRow,
  dto: UpdateProductDto,
): Prisma.ProductUncheckedUpdateManyInput {
  const changes: Prisma.ProductUncheckedUpdateManyInput = {};

  if (dto.name !== undefined && dto.name !== current.name) {
    changes.name = dto.name;
  }
  if (dto.sku !== undefined && dto.sku !== current.sku) changes.sku = dto.sku;
  if (dto.subtitle !== undefined && dto.subtitle !== current.subtitle) {
    changes.subtitle = dto.subtitle;
  }
  if (dto.brand !== undefined && dto.brand !== current.brand) {
    changes.brand = dto.brand;
  }
  if (
    dto.description !== undefined &&
    dto.description !== current.description
  ) {
    changes.description = dto.description;
  }
  if (dto.imageUrl !== undefined && dto.imageUrl !== current.imageUrl) {
    changes.imageUrl = dto.imageUrl;
  }
  if (
    dto.galleryUrls !== undefined &&
    !sameList(dto.galleryUrls, current.galleryUrls)
  ) {
    changes.galleryUrls = dto.galleryUrls;
  }
  if (dto.categoryId !== undefined && dto.categoryId !== current.categoryId) {
    changes.categoryId = dto.categoryId;
  }
  if (dto.status !== undefined && dto.status !== current.status) {
    changes.status = dto.status;
  }
  if (dto.price !== undefined && !sameAmount(current.price, dto.price)) {
    changes.price = toDecimal(dto.price);
  }
  if (dto.currency !== undefined && dto.currency !== current.currency) {
    changes.currency = dto.currency;
  }
  if (
    dto.costPrice !== undefined &&
    !sameAmount(current.costPrice, dto.costPrice)
  ) {
    changes.costPrice =
      dto.costPrice === null ? null : toDecimal(dto.costPrice);
  }
  if (dto.stock !== undefined && dto.stock !== current.stock) {
    changes.stock = dto.stock;
  }
  return changes;
}
