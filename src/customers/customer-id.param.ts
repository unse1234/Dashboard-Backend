import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { parseCustomerId } from './customer-id';

/** The customer number in a route param like "CUS-1001"; 400 when it is malformed. */
export function parseCustomerIdParam(value: unknown): number {
  const number = typeof value === 'string' ? parseCustomerId(value) : null;
  if (number === null) {
    throw new BadRequestException(
      'Validation failed (a customer id like "CUS-1001" is expected)',
    );
  }
  return number;
}

/**
 * Injects the customer number from the ":customerId" route param.
 *
 * Deliberately not `@Param('customerId', SomePipe) number: number`: the global
 * ValidationPipe (transform: true) runs first and casts any param declared as
 * `number` with Number(), turning "CUS-1001" into NaN. It never transforms a
 * custom decorator's value, so this always sees the raw string.
 */
export const CustomerNumberParam = createParamDecorator(
  (_data: unknown, context: ExecutionContext): number =>
    parseCustomerIdParam(
      context.switchToHttp().getRequest<Request>().params.customerId,
    ),
);
