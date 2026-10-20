import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import {
  CheckoutReceiptDto,
  ConfirmationTokenDto,
} from './dto/order-confirmation.dto';
import { OrderConfirmationService } from './order-confirmation.service';
import { OrderConfirmationSettings } from './order-confirmation.settings';
import type {
  CheckoutReceiptStatus,
  StorefrontConfirmationPreview,
  StorefrontConfirmationResult,
} from './storefront-order.mapper';

const MINUTE_MS = 60_000;

/**
 * Public routes for orders awaiting email confirmation. Tokens travel in the
 * request body only, never in a URL, so they stay out of access logs; and only
 * the POST to `confirm` changes anything. There is deliberately no GET that
 * takes a token: a link opened by a person or a mail scanner confirms nothing.
 */
@Public()
@Controller('storefront')
export class OrderConfirmationController {
  constructor(
    private readonly confirmations: OrderConfirmationService,
    private readonly settings: OrderConfirmationSettings,
  ) {}

  /** Which storefront features are switched on, so the storefront can adapt. */
  @Get('features')
  features(): { orderConfirmation: boolean; storefrontAccounts: boolean } {
    return {
      orderConfirmation: this.settings.enabled,
      storefrontAccounts: this.settings.accountsEnabled,
    };
  }

  /** What a confirmation link is about. Reads only: the link stays unused. */
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('order-confirmations/preview')
  preview(
    @Body() dto: ConfirmationTokenDto,
  ): Promise<StorefrontConfirmationPreview> {
    return this.confirmations.preview(dto.token);
  }

  /** Confirms the order, when the shopper presses the button. */
  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('order-confirmations/confirm')
  confirm(
    @Body() dto: ConfirmationTokenDto,
  ): Promise<StorefrontConfirmationResult> {
    return this.confirmations.confirm(dto.token);
  }

  /** How the guest's order stands, by the receipt token from checkout. */
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('checkout-receipts/status')
  receiptStatus(
    @Body() dto: CheckoutReceiptDto,
  ): Promise<CheckoutReceiptStatus> {
    return this.confirmations.receiptStatus(dto.receiptToken);
  }

  /** Sends the confirmation email again (new link; same deadline). */
  @Throttle({ default: { limit: 3, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('checkout-receipts/resend-confirmation')
  resend(@Body() dto: CheckoutReceiptDto): Promise<CheckoutReceiptStatus> {
    return this.confirmations.resend(dto.receiptToken);
  }
}
