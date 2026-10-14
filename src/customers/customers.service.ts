import { Injectable, NotFoundException } from '@nestjs/common';
import { escapeLike } from '../common/like.util';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { customerNumberFromSearch } from './customer-id';
import {
  customerAddressSelect,
  orderSummarySelect,
  toCustomerAddress,
  toCustomerListItem,
  toCustomerOrderAddress,
  toCustomerOrderSummary,
  type CustomerDetailsDto,
  type CustomerListItem,
  type CustomerOrderAddressRow,
  type CustomerRow,
} from './customer.mapper';
import type {
  CustomerSortColumn,
  ListCustomersQueryDto,
} from './dto/list-customers-query.dto';

/** How many of a customer's latest orders the details page lists. */
export const RECENT_ORDERS_LIMIT = 3;

/** How many distinct delivery addresses from a customer's orders it lists. */
export const ORDER_ADDRESSES_LIMIT = 10;

export interface CustomerPage {
  data: CustomerListItem[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

// ORDER BY expressions per sort column. Only these constants ever reach the SQL
// as raw text; everything that comes from the request is a bound parameter.
const SORT_EXPRESSIONS: Record<CustomerSortColumn, Prisma.Sql> = {
  id: Prisma.raw('c."number"'),
  // lower(): the default collation on some hosts sorts by byte, putting "ada" after "Zed".
  name: Prisma.raw('lower(c."name")'),
  email: Prisma.raw('c."email"'),
  totalOrders: Prisma.raw('s."totalOrders"'),
  totalSpent: Prisma.raw('s."totalSpent"'),
  joinedAt: Prisma.raw('c."createdAt"'),
};

// Breaks ties so that pages never overlap or skip rows.
const TIE_BREAK = Prisma.raw('c."createdAt" DESC, c."id" ASC');

/**
 * Customers with their order statistics, computed from the orders at read time:
 * every order counts towards totalOrders, only orders that were not cancelled
 * count towards totalSpent, and lastOrderAt is the latest order of any status.
 * The aggregate always yields one row, so customers without orders are kept.
 */
function selectCustomers(where: Prisma.Sql, tail: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT c."id", c."number", c."name", c."email", c."phone", c."createdAt",
           s."totalOrders", s."totalSpent", s."spentByCurrency", s."lastOrderAt"
    FROM "Customer" c
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS "totalOrders",
             COALESCE(sum(o."total") FILTER (WHERE o."status" <> 'CANCELLED'), 0) AS "totalSpent",
             max(o."createdAt") AS "lastOrderAt",
             -- Per currency, as text so the decimals stay exact. Amounts of
             -- different currencies are never added together here.
             COALESCE((
               SELECT jsonb_object_agg(per."currency", per."amount")
               FROM (
                 SELECT p."currency"::text AS "currency", sum(p."total")::text AS "amount"
                 FROM "Order" p
                 WHERE p."customerId" = c."id" AND p."status" <> 'CANCELLED'
                 GROUP BY p."currency"
               ) per
             ), '{}'::jsonb) AS "spentByCurrency"
      FROM "Order" o
      WHERE o."customerId" = c."id"
    ) s
    WHERE ${where}
    ${tail}`;
}

/** Name, email or phone contain the term (any case), or the term is the customer's id. */
function searchFilter(search: string | undefined): Prisma.Sql {
  if (!search) return Prisma.sql`TRUE`;
  const pattern = `%${escapeLike(search)}%`;
  const number = customerNumberFromSearch(search);
  return Prisma.sql`(
    c."name" ILIKE ${pattern}
    OR c."email" ILIKE ${pattern}
    OR c."phone" ILIKE ${pattern}
    ${number === null ? Prisma.empty : Prisma.sql`OR c."number" = ${number}`}
  )`;
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCustomersQueryDto): Promise<CustomerPage> {
    const where = searchFilter(query.search);
    const orderBy = query.sortBy
      ? Prisma.sql`${SORT_EXPRESSIONS[query.sortBy]} ${Prisma.raw(
          query.sortOrder === 'desc' ? 'DESC' : 'ASC',
        )}, ${TIE_BREAK}`
      : TIE_BREAK;

    const [counted, rows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS "total" FROM "Customer" c WHERE ${where}`,
      this.prisma.$queryRaw<CustomerRow[]>(
        selectCustomers(
          where,
          Prisma.sql`ORDER BY ${orderBy}
            LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
        ),
      ),
    ]);
    const total = counted[0].total;
    return {
      data: rows.map(toCustomerListItem),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  /** Everything the details page shows: the customer, their addresses and latest orders. */
  getDetails(number: number): Promise<CustomerDetailsDto> {
    // One snapshot, so the statistics agree with the orders listed beside them.
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<CustomerRow[]>(
          selectCustomers(Prisma.sql`c."number" = ${number}`, Prisma.empty),
        );
        if (!row) throw new NotFoundException('Customer not found');

        const addresses = await tx.customerAddress.findMany({
          where: { customerId: row.id },
          select: customerAddressSelect,
          orderBy: [
            { type: 'asc' },
            { isDefault: 'desc' },
            { createdAt: 'asc' },
            { id: 'asc' },
          ],
        });
        // Where the orders went, which is the only record of a guest's address:
        // identical snapshots are one entry, newest use first. Cancelled orders
        // count, since the customer did give that address.
        const orderAddresses = await tx.$queryRaw<CustomerOrderAddressRow[]>`
          SELECT o."shippingAddress" AS "address",
                 max(o."createdAt") AS "lastUsedAt",
                 count(*)::int AS "orderCount"
          FROM "Order" o
          WHERE o."customerId" = ${row.id}
          GROUP BY o."shippingAddress"
          ORDER BY max(o."createdAt") DESC, o."shippingAddress"::text ASC
          LIMIT ${ORDER_ADDRESSES_LIMIT}`;
        const orders = await tx.order.findMany({
          where: { customerId: row.id },
          select: orderSummarySelect,
          orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
          take: RECENT_ORDERS_LIMIT,
        });
        return {
          customer: toCustomerListItem(row),
          addresses: addresses.map((a) => toCustomerAddress(row.number, a)),
          orderAddresses: orderAddresses.map(toCustomerOrderAddress),
          recentOrders: orders.map((o) =>
            toCustomerOrderSummary(row.number, o),
          ),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
