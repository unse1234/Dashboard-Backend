import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { parsePublicId } from '../../common/public-id';

/**
 * The product number in the ":productId" route param ("PRD-1001"), or null when
 * it is not a product id.
 *
 * Unlike the dashboard's param decorator it never answers 400: on the public
 * catalogue a malformed id is answered exactly like an unknown one (404), so the
 * response says nothing about which ids exist. Custom decorators are skipped by
 * the global ValidationPipe, so the raw string always arrives here.
 */
export const StorefrontProductNumberParam = createParamDecorator(
  (_data: unknown, context: ExecutionContext): number | null => {
    const value = context.switchToHttp().getRequest<Request>().params.productId;
    return typeof value === 'string' ? parsePublicId('PRD', value) : null;
  },
);
