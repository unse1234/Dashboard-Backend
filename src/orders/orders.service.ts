import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { sha256 } from '../common/crypto.util';
import { escapeLike } from '../common/like.util';
import { toDecimal } from '../common/money';
import {
  formatPublicId,
  numberFromSearch,
  parsePublicId,
} from '../common/public-id';
import { Prisma, type OrderStatus } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { returnOrderStock } from './order-stock';
import type {
  CreateOrderDto,
  OrderAddressInputDto,
} from './dto/create-order.dto';
import type {
  ListOrdersQueryDto,
  OrderSortColumn,
} from './dto/list-orders-query.dto';
import {
  describeInvalidTransition,
  paymentStatusAfter,
} from './order-lifecycle';
import {
  PlacementError,
  placeOrder,
  type PlacementFailure,
} from './order-placement';
import {
  orderDetailSelect,
  toOrderDto,
  toOrderListItem,
  type OrderDto,
  type OrderListItemDto,
  type OrderListRow,
} from './order.mapper';

export interface OrderPage {
  data: OrderListItemDto[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export const CHANGED_MESSAGE =
  'This order was just changed by someone else. Reload it and try again.';
/**
 * Staff may not act on an order its buyer has not confirmed yet: it is not an
 * order until then, and its stock is only held. It confirms or cancels itself.
 */
export const AWAITING_CONFIRMATION_MESSAGE =
  'This order is waiting for the customer to confirm it by email. It can be changed once it is confirmed; if it is not confirmed in time, it is cancelled automatically.';
export const KEY_REUSED_MESSAGE =
  'This Idempotency-Key was already used for a different order';
export const MIXED_CURRENCY_MESSAGE =
  'All products in an order must be priced in the same currency';
export const TOO_LARGE_MESSAGE =
  'An order can be worth at most 9,999,999,999.99';

// ORDER BY expressions per sort column. Only these constants ever reach the SQL
// as raw text; everything that comes from the request is a bound parameter.
const SORT_EXPRESSIONS: Record<OrderSortColumn, Prisma.Sql> = {
  id: Prisma.raw('o."number"'),
  // lower(): the default collation on some hosts sorts by byte, putting "ada" after "Zed".
  customer: Prisma.raw('lower(o."customerName")'),
  createdAt: Prisma.raw('o."createdAt"'),
  itemCount: Prisma.raw('o."itemCount"'),
  total: Prisma.raw('o."total"'),
  // The enums sort in the order they are declared, which is the lifecycle's.
  paymentStatus: Prisma.raw('o."paymentStatus"'),
  status: Prisma.raw('o."status"'),
};

// Breaks ties so that pages never overlap or skip rows.
const TIE_BREAK = Prisma.raw('o."createdAt" DESC, o."number" DESC');

function listFilter(query: ListOrdersQueryDto): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  if (query.status) {
    conditions.push(Prisma.sql`o."status" = ${query.status}::"OrderStatus"`);
  }
  if (query.paymentStatus) {
    conditions.push(
      Prisma.sql`o."paymentStatus" = ${query.paymentStatus}::"PaymentStatus"`,
    );
  }
  if (query.customerId) {
    // The DTO has already checked that it is a customer id.
    const customerNumber = parsePublicId('CUS', query.customerId);
    conditions.push(Prisma.sql`c."number" = ${customerNumber}`);
  }
  if (query.search) {
    const pattern = `%${escapeLike(query.search)}%`;
    const number = numberFromSearch('ORD', query.search);
    conditions.push(Prisma.sql`(
      o."customerName" ILIKE ${pattern}
      OR o."customerEmail" ILIKE ${pattern}
      ${number === null ? Prisma.empty : Prisma.sql`OR o."number" = ${number}`}
    )`);
  }

  return conditions.length > 0
    ? Prisma.join(conditions, ' AND ')
    : Prisma.sql`TRUE`;
}

/** The dashboard's wording of a placement failure; it may name a SKU and a count. */
function adminException(failure: PlacementFailure): HttpException {
  switch (failure.kind) {
    case 'PRODUCT_UNAVAILABLE':
      return new BadRequestException(
        failure.productNumber === null
          ? 'A product in the order is not available'
          : `Product ${formatPublicId('PRD', failure.productNumber)} is not available`,
      );
    case 'INSUFFICIENT_STOCK':
      return new ConflictException(
        `Not enough stock for ${failure.sku} (${failure.available} available)`,
      );
    case 'MIXED_CURRENCY':
      return new BadRequestException(MIXED_CURRENCY_MESSAGE);
    case 'DISCOUNT_TOO_LARGE':
      return new BadRequestException(
        "The discount can't be more than the order is worth",
      );
    case 'TOO_LARGE':
      return new BadRequestException(TOO_LARGE_MESSAGE);
  }
}

const snapshotOf = (address: OrderAddressInputDto): Prisma.InputJsonObject => ({
  recipientName: address.recipientName,
  phone: address.phone ?? null,
  addressLine1: address.addressLine1,
  addressLine2: address.addressLine2 ?? null,
  city: address.city,
  region: address.region ?? null,
  postalCode: address.postalCode ?? null,
  country: address.country,
});

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListOrdersQueryDto): Promise<OrderPage> {
    const where = listFilter(query);
    const orderBy = query.sortBy
      ? Prisma.sql`${SORT_EXPRESSIONS[query.sortBy]} ${Prisma.raw(
          query.sortOrder === 'desc' ? 'DESC' : 'ASC',
        )}, ${TIE_BREAK}`
      : TIE_BREAK;

    const [counted, rows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS "total"
        FROM "Order" o
        JOIN "Customer" c ON c."id" = o."customerId"
        WHERE ${where}`,
      this.prisma.$queryRaw<OrderListRow[]>`
        SELECT o."number", c."number" AS "customerNumber", o."customerName",
               o."customerEmail", o."customerPhone", o."status",
               o."paymentStatus", o."paymentMethod", o."currency",
               o."itemCount", o."total", o."createdAt",
               o."confirmationStatus", o."confirmationExpiresAt",
               o."confirmedAt"
        FROM "Order" o
        JOIN "Customer" c ON c."id" = o."customerId"
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
    ]);
    const total = counted[0].total;
    return {
      data: rows.map(toOrderListItem),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async get(number: number): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { number },
      select: orderDetailSelect,
    });
    if (!order) throw new NotFoundException('Order not found');
    return toOrderDto(order);
  }

  /**
   * Places an order: takes the stock, prices the lines from the products as
   * they are at that moment, snapshots the customer, the addresses and the
   * lines, and records who did it, all in one transaction. Either the whole
   * order exists afterwards or nothing changed.
   *
   * `key` makes it safe to retry. The same key with the same request returns
   * the order that was already placed (no second deduction); the same key with
   * a different request is refused. Requests that share a key are serialised by
   * an advisory lock, so two of them racing cannot both place an order, nor can
   * the loser be answered "not enough stock" for an order that was in fact placed.
   */
  create(
    actor: AuthenticatedUser,
    key: string,
    dto: CreateOrderDto,
  ): Promise<OrderDto> {
    // The DTO has checked that every id is well formed.
    const customerNumber = parsePublicId('CUS', dto.customerId) as number;
    const lines = dto.items.map(({ productId, quantity }) => ({
      number: parsePublicId('PRD', productId) as number,
      quantity,
    }));
    if (new Set(lines.map((line) => line.number)).size !== lines.length) {
      throw new BadRequestException('Each product can appear only once');
    }

    const adjustments = {
      shipping: toDecimal(dto.shipping ?? 0),
      discount: toDecimal(dto.discount ?? 0),
      tax: toDecimal(dto.tax ?? 0),
    };
    const paymentStatus = dto.paymentStatus ?? 'PENDING';
    const shippingAddress = snapshotOf(dto.shippingAddress);
    const billingAddress = dto.billingAddress
      ? snapshotOf(dto.billingAddress)
      : shippingAddress;

    // The same order however its lines are listed, so a retry that reorders
    // them is still the same request.
    const requestHash = sha256(
      JSON.stringify({
        customerNumber,
        lines: [...lines].sort((a, b) => a.number - b.number),
        shipping: adjustments.shipping.toFixed(2),
        discount: adjustments.discount.toFixed(2),
        tax: adjustments.tax.toFixed(2),
        paymentStatus,
        shippingAddress,
        billingAddress,
      }),
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

      const existing = await tx.order.findUnique({
        where: { idempotencyKey: key },
        select: { ...orderDetailSelect, requestHash: true },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(KEY_REUSED_MESSAGE);
        }
        return toOrderDto(existing);
      }

      const customer = await tx.customer.findUnique({
        where: { number: customerNumber },
        select: { id: true, name: true, email: true, phone: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');

      try {
        const order = await placeOrder(tx, {
          customer,
          lines,
          adjustments,
          paymentStatus,
          // Orders placed here keep the null "unspecified" method, as before.
          paymentMethod: null,
          shippingAddress,
          billingAddress,
          actorId: actor.id,
          key,
          requestHash,
        });
        return toOrderDto(order);
      } catch (error) {
        throw error instanceof PlacementError
          ? adminException(error.failure)
          : error;
      }
    });
  }

  /**
   * Moves an order to `target`, if its lifecycle and payment allow it.
   *
   * The change is a compare-and-set against the status and payment the rules
   * were checked on, so of two people acting on the same order at once exactly
   * one changes it. The other finds it already where they wanted it (and is
   * told so, with nothing done twice) or is refused. Cancelling puts the stock
   * back in the same transaction, and only for the request that changed the
   * order, so it can never be put back twice.
   */
  updateStatus(
    actor: AuthenticatedUser,
    number: number,
    target: OrderStatus,
  ): Promise<OrderDto> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({
        where: { number },
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          // Never changes after the order is placed, so it needs no part in
          // the compare-and-set below.
          paymentMethod: true,
          confirmationStatus: true,
        },
      });
      if (!current) throw new NotFoundException('Order not found');

      // Asking for the status it has is not a change: acknowledge, do nothing.
      if (current.status !== target) {
        if (current.confirmationStatus === 'AWAITING_CONFIRMATION') {
          throw new ConflictException(AWAITING_CONFIRMATION_MESSAGE);
        }
        const problem = describeInvalidTransition(
          current.status,
          target,
          current.paymentStatus,
          current.paymentMethod,
        );
        if (problem) throw new ConflictException(problem);

        const paymentStatus = paymentStatusAfter(target, current.paymentStatus);
        const { count } = await tx.order.updateMany({
          where: {
            id: current.id,
            status: current.status,
            paymentStatus: current.paymentStatus,
            // An order confirmed or expired meanwhile is a different order now.
            confirmationStatus: current.confirmationStatus,
          },
          data: { status: target, paymentStatus },
        });

        if (count === 0) {
          const latest = await tx.order.findUnique({
            where: { id: current.id },
            select: { status: true },
          });
          if (latest?.status !== target) {
            throw new ConflictException(CHANGED_MESSAGE);
          }
        } else {
          if (target === 'CANCELLED') {
            await returnOrderStock(tx, current.id, number);
          }
          await tx.orderEvent.create({
            data: {
              orderId: current.id,
              type: 'STATUS_CHANGED',
              fromStatus: current.status,
              toStatus: target,
              fromPaymentStatus: current.paymentStatus,
              toPaymentStatus: paymentStatus,
              actorId: actor.id,
            },
          });
        }
      }

      return this.read(tx, number);
    });
  }

  /**
   * Records that the payment arrived (cash on delivery, a bank transfer, ...).
   * It is the only change a person makes to a payment status: a refund is
   * recorded by cancelling the order, and a payment is never un-paid.
   */
  markPaid(
    actor: AuthenticatedUser,
    number: number,
    paymentStatus: 'PAID',
  ): Promise<OrderDto> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({
        where: { number },
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          confirmationStatus: true,
        },
      });
      if (!current) throw new NotFoundException('Order not found');

      if (current.paymentStatus !== paymentStatus) {
        if (current.status === 'CANCELLED') {
          throw new ConflictException(
            "A cancelled order can't be marked as paid.",
          );
        }
        if (current.confirmationStatus === 'AWAITING_CONFIRMATION') {
          throw new ConflictException(AWAITING_CONFIRMATION_MESSAGE);
        }

        const { count } = await tx.order.updateMany({
          where: {
            id: current.id,
            status: current.status,
            paymentStatus: current.paymentStatus,
            confirmationStatus: current.confirmationStatus,
          },
          data: { paymentStatus },
        });
        if (count === 0) {
          const latest = await tx.order.findUnique({
            where: { id: current.id },
            select: { paymentStatus: true },
          });
          if (latest?.paymentStatus !== paymentStatus) {
            throw new ConflictException(CHANGED_MESSAGE);
          }
        } else {
          await tx.orderEvent.create({
            data: {
              orderId: current.id,
              type: 'PAYMENT_STATUS_CHANGED',
              fromPaymentStatus: current.paymentStatus,
              toPaymentStatus: paymentStatus,
              actorId: actor.id,
            },
          });
        }
      }

      return this.read(tx, number);
    });
  }

  private async read(db: Db, number: number): Promise<OrderDto> {
    const order = await db.order.findUniqueOrThrow({
      where: { number },
      select: orderDetailSelect,
    });
    return toOrderDto(order);
  }
}
