import {
  BadRequestException,
  ConflictException,
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
import {
  deductStock,
  restoreStock,
  type DeductedStock,
} from '../products/inventory';
import { toEventRows } from '../products/product-events';
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
  commonCurrency,
  exceedsMaxOrderAmount,
  exceedsOrderValue,
  priceOrder,
} from './order-pricing';
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
               o."itemCount", o."total", o."createdAt"
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

      const products = await tx.product.findMany({
        where: { number: { in: lines.map((line) => line.number) } },
        select: {
          id: true,
          number: true,
          status: true,
          archivedAt: true,
          currency: true,
        },
      });
      const byNumber = new Map(products.map((p) => [p.number, p]));
      const requested = lines.map((line) => {
        const product = byNumber.get(line.number);
        if (!product || product.status !== 'ACTIVE' || product.archivedAt) {
          throw new BadRequestException(
            `Product ${formatPublicId('PRD', line.number)} is not available`,
          );
        }
        return { ...line, productId: product.id, currency: product.currency };
      });
      // Refused before any stock is taken. The currency read together with each
      // deduction below is the one that counts.
      if (commonCurrency(requested.map((line) => line.currency)) === null) {
        throw new BadRequestException(MIXED_CURRENCY_MESSAGE);
      }

      // Always in the same order (by id), so that two orders for overlapping
      // products wait for each other's rows in turn instead of deadlocking.
      const byProductId = [...requested].sort((a, b) =>
        a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
      );
      const taken = new Map<string, DeductedStock>();
      for (const { productId, quantity } of byProductId) {
        const deducted = await deductStock(tx, productId, quantity);
        if (!deducted) throw await this.whyNoStock(tx, productId);
        taken.set(productId, deducted);
      }

      // Back in the order the lines were sent in, which is how they will list.
      const ordered = requested.map((line) => ({
        quantity: line.quantity,
        stock: taken.get(line.productId)!,
      }));
      const currency = commonCurrency(
        ordered.map(({ stock }) => stock.currency),
      );
      if (currency === null)
        throw new BadRequestException(MIXED_CURRENCY_MESSAGE);
      const price = priceOrder(
        ordered.map(({ quantity, stock }) => ({
          unitPrice: stock.price,
          quantity,
        })),
        adjustments,
      );
      if (exceedsOrderValue(price, adjustments)) {
        throw new BadRequestException(
          "The discount can't be more than the order is worth",
        );
      }
      // Before the insert, so a big order is refused cleanly (and the stock it
      // took rolled back) instead of failing inside the database.
      if (
        exceedsMaxOrderAmount(price.subtotal) ||
        exceedsMaxOrderAmount(price.total)
      ) {
        throw new BadRequestException(TOO_LARGE_MESSAGE);
      }

      const order = await tx.order.create({
        data: {
          customerId: customer.id,
          // Snapshots: the order keeps reading the same if these change.
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          status: 'PENDING',
          paymentStatus,
          currency,
          subtotal: price.subtotal,
          shipping: adjustments.shipping,
          discount: adjustments.discount,
          tax: adjustments.tax,
          total: price.total,
          shippingAddress,
          billingAddress,
          itemCount: ordered.reduce((sum, line) => sum + line.quantity, 0),
          idempotencyKey: key,
          requestHash,
          items: {
            create: ordered.map(({ quantity, stock }, index) => ({
              productId: formatPublicId('PRD', stock.number),
              productName: stock.name,
              sku: stock.sku,
              quantity,
              unitPrice: stock.price,
              total: price.lineTotals[index],
              position: index,
              catalogProductId: stock.id,
            })),
          },
        },
        select: orderDetailSelect,
      });

      await tx.productEvent.createMany({
        data: [...taken.values()].flatMap((stock) =>
          toEventRows(stock.id, null, [
            {
              type: 'STOCK_CHANGED',
              data: {
                from: stock.stockBefore,
                to: stock.stockAfter,
                reason: 'ORDER_PLACED',
                orderNumber: order.number,
              },
            },
          ]),
        ),
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: 'CREATED',
          toStatus: 'PENDING',
          toPaymentStatus: paymentStatus,
          actorId: actor.id,
        },
      });

      return toOrderDto(order);
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
        select: { id: true, status: true, paymentStatus: true },
      });
      if (!current) throw new NotFoundException('Order not found');

      // Asking for the status it has is not a change: acknowledge, do nothing.
      if (current.status !== target) {
        const problem = describeInvalidTransition(
          current.status,
          target,
          current.paymentStatus,
        );
        if (problem) throw new ConflictException(problem);

        const paymentStatus = paymentStatusAfter(target, current.paymentStatus);
        const { count } = await tx.order.updateMany({
          where: {
            id: current.id,
            status: current.status,
            paymentStatus: current.paymentStatus,
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
            await this.returnStock(tx, current.id, number);
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
        select: { id: true, status: true, paymentStatus: true },
      });
      if (!current) throw new NotFoundException('Order not found');

      if (current.paymentStatus !== paymentStatus) {
        if (current.status === 'CANCELLED') {
          throw new ConflictException(
            "A cancelled order can't be marked as paid.",
          );
        }

        const { count } = await tx.order.updateMany({
          where: {
            id: current.id,
            status: current.status,
            paymentStatus: current.paymentStatus,
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

  /** Why nothing could be taken from a product: gone, switched off, or not enough. */
  private async whyNoStock(db: Db, productId: string): Promise<Error> {
    const product = await db.product.findUnique({
      where: { id: productId },
      select: {
        number: true,
        sku: true,
        stock: true,
        status: true,
        archivedAt: true,
      },
    });
    if (!product || product.status !== 'ACTIVE' || product.archivedAt) {
      return new BadRequestException(
        product
          ? `Product ${formatPublicId('PRD', product.number)} is not available`
          : 'A product in the order is not available',
      );
    }
    return new ConflictException(
      `Not enough stock for ${product.sku} (${product.stock} available)`,
    );
  }

  /** Puts back what an order took, and records it on each product's history. */
  private async returnStock(
    db: Db,
    orderId: string,
    orderNumber: number,
  ): Promise<void> {
    const lines = await db.orderItem.findMany({
      where: { orderId, catalogProductId: { not: null } },
      select: { catalogProductId: true, quantity: true },
    });

    const quantities = new Map<string, number>();
    for (const { catalogProductId, quantity } of lines) {
      if (catalogProductId === null) continue;
      quantities.set(
        catalogProductId,
        (quantities.get(catalogProductId) ?? 0) + quantity,
      );
    }

    const restored = await restoreStock(
      db,
      [...quantities].map(([productId, quantity]) => ({ productId, quantity })),
    );
    if (restored.length === 0) return;
    await db.productEvent.createMany({
      data: restored.flatMap((stock) =>
        toEventRows(stock.id, null, [
          {
            type: 'STOCK_CHANGED',
            data: {
              from: stock.stockBefore,
              to: stock.stockAfter,
              reason: 'ORDER_CANCELLED',
              orderNumber,
            },
          },
        ]),
      ),
    });
  }
}
