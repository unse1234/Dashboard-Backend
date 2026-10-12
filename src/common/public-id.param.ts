import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { parsePublicId, type PublicIdPrefix } from './public-id';

const NOUNS: Record<PublicIdPrefix, string> = {
  CUS: 'a customer',
  ORD: 'an order',
  PRD: 'a product',
};

/** The number in a route param like "PRD-1001"; 400 when it is malformed. */
export function parsePublicIdParam(
  prefix: PublicIdPrefix,
  value: unknown,
): number {
  const number =
    typeof value === 'string' ? parsePublicId(prefix, value) : null;
  if (number === null) {
    throw new BadRequestException(
      `Validation failed (${NOUNS[prefix]} id like "${prefix}-1001" is expected)`,
    );
  }
  return number;
}

/**
 * Injects the number from a public-id route param:
 * `@PublicNumberParam({ prefix: 'PRD', param: 'productId' }) number: number`.
 *
 * Deliberately not `@Param('productId', SomePipe) number: number`: the global
 * ValidationPipe (transform: true) runs first and casts any param declared as
 * `number` with Number(), turning "PRD-1001" into NaN. It never transforms a
 * custom decorator's value, so this always sees the raw string.
 */
export const PublicNumberParam = createParamDecorator(
  (
    options: { prefix: PublicIdPrefix; param: string },
    context: ExecutionContext,
  ): number =>
    parsePublicIdParam(
      options.prefix,
      context.switchToHttp().getRequest<Request>().params[options.param],
    ),
);
