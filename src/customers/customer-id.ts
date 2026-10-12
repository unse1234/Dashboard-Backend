import {
  formatPublicId,
  numberFromSearch,
  parsePublicId,
} from '../common/public-id';

/** Public ids are "CUS-<number>" and "ORD-<number>"; internal uuids are never exposed. */
export const formatCustomerId = (number: number) =>
  formatPublicId('CUS', number);
export const formatOrderId = (number: number) => formatPublicId('ORD', number);

/** The customer number in a public id such as "CUS-1001" (any case), or null. */
export const parseCustomerId = (value: string) => parsePublicId('CUS', value);

/**
 * The customer number a search term names, if it looks like an id: "CUS-1001",
 * "cus1001" or a bare "1001". Null otherwise.
 */
export const customerNumberFromSearch = (term: string) =>
  numberFromSearch('CUS', term);
