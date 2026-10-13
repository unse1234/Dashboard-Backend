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
  constructor(private readonly prisma: PrismaService) {}

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
      data: rows.map(toProductDto),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async get(number: number): Promise<ProductDto> {
    return toProductDto(await this.findActive(this.prisma, number));
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
    try {
      return await this.prisma.$transaction(async (tx) => {
        return toProductDto(await createProductInTransaction(tx, actor, dto));
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

    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await this.findActive(tx, number);
        if (current.version !== dto.version) {
          throw new ConflictException(STALE_VERSION_MESSAGE);
        }

        const changes = changedFields(current, dto);
        // The form sends every field every time, so "nothing differs" is normal:
        // acknowledge it without bumping the version or writing history.
        if (Object.keys(changes).length === 0) return toProductDto(current);

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
        return toProductDto(updated);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(SKU_TAKEN_MESSAGE);
      }
      throw error;
    }
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
