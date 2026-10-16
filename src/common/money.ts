import { Prisma } from '../generated/prisma/client';

/** What a NUMERIC(12,2) column can come back as. */
export type MoneyValue = Prisma.Decimal | string | number;

/**
 * Amounts leave the API as JSON numbers in their recorded currency. NUMERIC(12,2) values are far
 * inside the range a double holds exactly to the cent.
 */
export const toAmount = (value: MoneyValue): number => Number(value);

/**
 * An amount the API received, as the exact decimal to store. Request amounts are
 * validated to at most two decimals first, so `toFixed(2)` only pads.
 */
export const toDecimal = (amount: number): Prisma.Decimal =>
  new Prisma.Decimal(amount.toFixed(2));
