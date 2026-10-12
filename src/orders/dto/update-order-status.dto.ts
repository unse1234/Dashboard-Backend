import { IsEnum, IsIn } from 'class-validator';
import { OrderStatus } from '../../generated/prisma/client';

export class UpdateOrderStatusDto {
  /** Which moves are allowed is for the API to decide; see order-lifecycle.ts. */
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}

export class UpdatePaymentStatusDto {
  // The only change a person makes to a payment is recording that it arrived.
  // REFUNDED comes from cancelling a paid order, and nothing goes back to PENDING.
  @IsIn(['PAID'])
  paymentStatus!: 'PAID';
}
