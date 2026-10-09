/** Public ids are "CUS-<number>" and "ORD-<number>"; internal uuids are never exposed. */
export const formatCustomerId = (number: number) => `CUS-${number}`;
export const formatOrderId = (number: number) => `ORD-${number}`;

// The number columns are Postgres INTEGER.
const MAX_NUMBER = 2_147_483_647;
const CUSTOMER_ID = /^CUS-([1-9]\d{0,9})$/i;
const CUSTOMER_SEARCH = /^(?:CUS-?)?([1-9]\d{0,9})$/i;

const inRange = (digits: string) => {
  const number = Number(digits);
  return number <= MAX_NUMBER ? number : null;
};

/** The customer number in a public id such as "CUS-1001" (any case), or null. */
export function parseCustomerId(value: string): number | null {
  const match = CUSTOMER_ID.exec(value);
  return match ? inRange(match[1]) : null;
}

/**
 * The customer number a search term names, if it looks like an id: "CUS-1001",
 * "cus1001" or a bare "1001". Null otherwise.
 */
export function customerNumberFromSearch(term: string): number | null {
  const match = CUSTOMER_SEARCH.exec(term);
  return match ? inRange(match[1]) : null;
}
