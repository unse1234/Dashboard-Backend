import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import {
  UpdateOrderStatusDto,
  UpdatePaymentStatusDto,
} from './dto/update-order-status.dto';
import { OrderNumberParam } from './order-id.param';
import type { OrderDto } from './order.mapper';
import { OrdersService, type OrderPage } from './orders.service';

// 8 to 100 characters that are safe in a header and in logs; a UUID fits.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

// Both dashboard roles work the orders, as the sidebar shows; verified email is
// enforced globally. Placing an order is narrowed to administrators below.
@Roles('ADMIN', 'STAFF')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query() query: ListOrdersQueryDto): Promise<OrderPage> {
    return this.orders.list(query);
  }

  @Get(':orderId')
  get(@OrderNumberParam() number: number): Promise<OrderDto> {
    return this.orders.get(number);
  }

  // For a storefront or a script: the dashboard has no screen that places
  // orders. Administrators only, until a storefront has credentials of its own.
  @Roles('ADMIN')
  @Post()
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateOrderDto,
  ): Promise<OrderDto> {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new BadRequestException(
        'Send an Idempotency-Key header of 8 to 100 letters, digits, "-" or "_" (a UUID works)',
      );
    }
    return this.orders.create(actor, key, dto);
  }

  @Patch(':orderId/status')
  updateStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @OrderNumberParam() number: number,
    @Body() dto: UpdateOrderStatusDto,
  ): Promise<OrderDto> {
    return this.orders.updateStatus(actor, number, dto.status);
  }

  @Patch(':orderId/payment-status')
  updatePaymentStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @OrderNumberParam() number: number,
    @Body() dto: UpdatePaymentStatusDto,
  ): Promise<OrderDto> {
    return this.orders.markPaid(actor, number, dto.paymentStatus);
  }
}
