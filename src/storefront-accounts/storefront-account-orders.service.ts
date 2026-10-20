import { Injectable, NotFoundException } from '@nestjs/common';
import { parsePublicId } from '../common/public-id';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AccountOrdersQueryDto } from './dto/storefront-account.dto';
import { linkVerifiedOrders } from './order-ownership';
import {
  accountOrderSelect,
  accountOrderSummarySelect,
  toAccountOrder,
  toAccountOrderSummary,
  type StorefrontAccountOrder,
  type StorefrontAccountOrderPage,
} from './storefront-account-orders';
import type { StorefrontAccountProfile } from './storefront-sessions.service';

const orderNotFound = () => new NotFoundException('Order not found');

/**
 * A signed-in shopper's order history. The account is always the one
 * StorefrontAuthGuard read from the session, never anything in the request,
 * and every query filters by it in SQL: another account's order, a guessed
 * number and a malformed id are the same 404.
 */
@Injectable()
export class StorefrontAccountOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Newest first (ties by number), one page at a time, straight off the
   * `[storefrontAccountId, createdAt DESC, number DESC]` index: one count and
   * one page query, no order lines.
   */
  async list(
    account: StorefrontAccountProfile,
    query: AccountOrdersQueryDto,
  ): Promise<StorefrontAccountOrderPage> {
    await this.reconcile(account);
    const where = ownedBy(account);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: accountOrderSummarySelect,
      }),
    ]);
    return {
      data: rows.map(toAccountOrderSummary),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  /** One of the account's orders, by its reference ("ORD-1001"). */
  async get(
    account: StorefrontAccountProfile,
    orderId: string,
  ): Promise<StorefrontAccountOrder> {
    const number = parsePublicId('ORD', orderId);
    if (number === null) throw orderNotFound();
    await this.reconcile(account);
    const order = await this.prisma.order.findFirst({
      where: { ...ownedBy(account), number },
      select: accountOrderSelect,
    });
    if (!order) throw orderNotFound();
    return toAccountOrder(order);
  }

  /**
   * Links confirmed orders of the account's address that belong to nobody.
   * Confirmation and setup link them already; this catches the one gap: an
   * order confirmed while the account was being created (its confirmation
   * read "no account" just before the account committed). Usually a no-op.
   */
  private async reconcile(account: StorefrontAccountProfile): Promise<void> {
    await linkVerifiedOrders(this.prisma, account);
  }
}

/** The account's orders. Owned orders are confirmed ones; said again here. */
const ownedBy = (
  account: StorefrontAccountProfile,
): Prisma.OrderWhereInput => ({
  storefrontAccountId: account.id,
  confirmationStatus: 'CONFIRMED',
});
