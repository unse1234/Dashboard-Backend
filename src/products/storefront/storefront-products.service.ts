import { Injectable, NotFoundException } from '@nestjs/common';
import { escapeLike } from '../../common/like.util';
import { toAmount } from '../../common/money';
import { formatPublicId } from '../../common/public-id';
import { Prisma, type Currency } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  StorefrontListProductsQueryDto,
  StorefrontSort,
} from './dto/storefront-list-products-query.dto';
import {
  eligibleProduct,
  storefrontProductColumns,
  type StorefrontProductRow,
} from './storefront-catalog';
import {
  toStorefrontProduct,
  type StorefrontProductDto,
} from './storefront-product.mapper';

export interface StorefrontProductPage {
  data: StorefrontProductDto[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

/** How many unprepared products the readiness report names. */
export const READINESS_LIST_LIMIT = 100;

export interface CatalogReadinessDto {
  /** Products a visitor can see. */
  eligible: number;
  /** Active, unarchived products the storefront is hiding because they have no price. */
  excludedCount: number;
  /** The first `READINESS_LIST_LIMIT` of them, by id. */
  excluded: {
    id: string;
    name: string;
    currency: Currency;
    price: number;
  }[];
}

// ORDER BY expressions per sort option. Only these constants ever reach the SQL
// as raw text; everything that comes from the request is a bound parameter.
// Every option ends in the product number, which is unique, so pages never
// overlap or skip a row.
const SORT_EXPRESSIONS: Record<StorefrontSort, Prisma.Sql> = {
  newest: Prisma.raw('p."createdAt" DESC, p."number" ASC'),
  price_asc: Prisma.raw('p."price" ASC, p."createdAt" DESC, p."number" ASC'),
  price_desc: Prisma.raw('p."price" DESC, p."createdAt" DESC, p."number" ASC'),
  // lower(): the default collation on some hosts sorts by byte, putting "ada" after "Zed".
  name: Prisma.raw('lower(p."name") ASC, p."createdAt" DESC, p."number" ASC'),
};

function listFilter(query: StorefrontListProductsQueryDto): Prisma.Sql {
  const conditions: Prisma.Sql[] = [eligibleProduct];

  if (query.categoryId) {
    conditions.push(Prisma.sql`p."categoryId" = ${query.categoryId}`);
  }
  if (query.search) {
    const pattern = `%${escapeLike(query.search)}%`;
    conditions.push(Prisma.sql`(
      p."name" ILIKE ${pattern}
      OR p."subtitle" ILIKE ${pattern}
      OR p."brand" ILIKE ${pattern}
    )`);
  }
  return Prisma.join(conditions, ' AND ');
}

@Injectable()
export class StorefrontProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: StorefrontListProductsQueryDto,
  ): Promise<StorefrontProductPage> {
    const where = listFilter(query);

    // One snapshot, so the count agrees with the page beside it.
    const [counted, rows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS "total"
        FROM "Product" p
        WHERE ${where}`,
      this.prisma.$queryRaw<StorefrontProductRow[]>`
        SELECT ${storefrontProductColumns}
        FROM "Product" p
        JOIN "Category" c ON c."id" = p."categoryId"
        WHERE ${where}
        ORDER BY ${SORT_EXPRESSIONS[query.sort]}
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
    ]);
    const total = counted[0].total;
    return {
      data: rows.map(toStorefrontProduct),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  /**
   * One product. A product that does not exist, is switched off, is archived or
   * is not storefront-eligible is the same 404: the response never says which.
   */
  async get(number: number | null): Promise<StorefrontProductDto> {
    if (number === null) throw new NotFoundException('Product not found');

    const [row] = await this.prisma.$queryRaw<StorefrontProductRow[]>`
      SELECT ${storefrontProductColumns}
      FROM "Product" p
      JOIN "Category" c ON c."id" = p."categoryId"
      WHERE p."number" = ${number} AND ${eligibleProduct}
      LIMIT 1`;
    if (!row) throw new NotFoundException('Product not found');
    return toStorefrontProduct(row);
  }

  /**
   * For staff: which active products the storefront is not showing because
   * they have no price.
   */
  async readiness(): Promise<CatalogReadinessDto> {
    const [counts, excluded] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ eligible: number; excluded: number }[]>`
        SELECT count(*) FILTER (WHERE ${eligibleProduct})::int AS "eligible",
               count(*) FILTER (WHERE NOT ${eligibleProduct})::int AS "excluded"
        FROM "Product" p
        WHERE p."archivedAt" IS NULL AND p."status" = 'ACTIVE'`,
      this.prisma.$queryRaw<
        { number: number; name: string; currency: Currency; price: string }[]
      >`
        SELECT p."number", p."name", p."currency"::text AS "currency",
               p."price"::text AS "price"
        FROM "Product" p
        WHERE p."archivedAt" IS NULL AND p."status" = 'ACTIVE'
          AND NOT ${eligibleProduct}
        ORDER BY p."number" ASC
        LIMIT ${READINESS_LIST_LIMIT}`,
    ]);
    return {
      eligible: counts[0].eligible,
      excludedCount: counts[0].excluded,
      excluded: excluded.map((row) => ({
        id: formatPublicId('PRD', row.number),
        name: row.name,
        currency: row.currency,
        price: toAmount(row.price),
      })),
    };
  }
}
