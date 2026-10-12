/**
 * Public ids are "<PREFIX>-<number>": CUS- customers, ORD- orders, PRD- products.
 * Internal uuids are never exposed. The number is a Postgres INTEGER column
 * (an autoincrement sequence), so ids are range-checked.
 */
export type PublicIdPrefix = 'CUS' | 'ORD' | 'PRD';

const MAX_NUMBER = 2_147_483_647;

// No leading zeros: "CUS-01001" is not an id, so one number has one spelling.
const ID_PATTERNS: Record<PublicIdPrefix, RegExp> = {
  CUS: /^CUS-([1-9]\d{0,9})$/i,
  ORD: /^ORD-([1-9]\d{0,9})$/i,
  PRD: /^PRD-([1-9]\d{0,9})$/i,
};

// What a search box accepts: the prefixed id, the prefix without its dash, or the bare number.
const SEARCH_PATTERNS: Record<PublicIdPrefix, RegExp> = {
  CUS: /^(?:CUS-?)?([1-9]\d{0,9})$/i,
  ORD: /^(?:ORD-?)?([1-9]\d{0,9})$/i,
  PRD: /^(?:PRD-?)?([1-9]\d{0,9})$/i,
};

const inRange = (digits: string) => {
  const number = Number(digits);
  return number <= MAX_NUMBER ? number : null;
};

export const formatPublicId = (prefix: PublicIdPrefix, number: number) =>
  `${prefix}-${number}`;

/** The number in a public id such as "PRD-1001" (any case), or null. */
export function parsePublicId(
  prefix: PublicIdPrefix,
  value: string,
): number | null {
  const match = ID_PATTERNS[prefix].exec(value);
  return match ? inRange(match[1]) : null;
}

/**
 * The number a search term names, if it looks like an id: "PRD-1001",
 * "prd1001" or a bare "1001". Null otherwise.
 */
export function numberFromSearch(
  prefix: PublicIdPrefix,
  term: string,
): number | null {
  const match = SEARCH_PATTERNS[prefix].exec(term);
  return match ? inRange(match[1]) : null;
}
