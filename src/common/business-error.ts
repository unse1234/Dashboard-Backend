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
  | 'UNSUPPORTED_DESTINATION';

const STATUS_TEXT: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
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
