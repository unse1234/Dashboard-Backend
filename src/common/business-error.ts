import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Machine-readable reasons a storefront request is refused for business (not
 * validation) reasons. The client switches on `code`; `message` is for people.
 */
export type BusinessErrorCode =
  /** The bag itself is malformed: a repeated product, a quantity beyond the limit. */
  | 'INVALID_BAG'
  /** A product is not for sale (unknown, switched off, archived or unpriced). */
  | 'PRODUCT_UNAVAILABLE'
  /** A product is priced in another currency than the rest of the bag. */
  | 'CURRENCY_MISMATCH'
  /** A product is for sale, but not in the quantity asked for. */
  | 'INSUFFICIENT_STOCK'
  /** The bag is worth more than an order can record. */
  | 'ORDER_TOO_LARGE'
  /** The quote the order was based on is stale, expired or does not match. */
  | 'QUOTE_CHANGED'
  /** An Idempotency-Key was reused for a different order. */
  | 'IDEMPOTENCY_CONFLICT'
  /** The delivery address is outside the countries the storefront serves. */
  | 'UNSUPPORTED_DESTINATION'
  /** The address already has as many orders waiting for confirmation as allowed. */
  | 'TOO_MANY_PENDING_ORDERS'
  /** A confirmation link that is unknown, malformed or for something else. */
  | 'CONFIRMATION_NOT_FOUND'
  /** The order was not confirmed in time and has been cancelled. */
  | 'CONFIRMATION_EXPIRED'
  /** A newer confirmation email replaced this link. */
  | 'CONFIRMATION_LINK_REPLACED'
  /** The order is no longer waiting for confirmation (confirmed or expired). */
  | 'CONFIRMATION_NOT_PENDING'
  /** A checkout receipt that is unknown, malformed, expired or for something else. */
  | 'RECEIPT_NOT_FOUND'
  /** The confirmation email may not be sent again for this order. */
  | 'RESEND_LIMIT_REACHED'
  /** The confirmation email was sent too recently to send again yet. */
  | 'RESEND_TOO_SOON'
  /** An account setup token that is unknown, malformed, used or replaced. */
  | 'SETUP_TOKEN_INVALID'
  /** An account setup token past its time; a new link can be asked for. */
  | 'SETUP_TOKEN_EXPIRED'
  /** The address already has a storefront account: sign in or reset instead. */
  | 'ACCOUNT_EXISTS'
  /** The password and its confirmation differ. */
  | 'PASSWORD_MISMATCH'
  /** A password reset token that is unknown, malformed, used or expired. */
  | 'RESET_TOKEN_INVALID';

const STATUS_TEXT: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.GONE]: 'Gone',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
};

/**
 * An HttpException in the shape the API already uses (`statusCode`, `error`,
 * `message`) with a `code` and any extra fields added.
 */
export class BusinessException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: BusinessErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(
      {
        statusCode: status,
        error: STATUS_TEXT[status] ?? 'Error',
        message,
        code,
        ...extra,
      },
      status,
    );
  }
}
