import {
  parsePublicIdParam,
  PublicNumberParam,
} from '../common/public-id.param';

/** The customer number in a route param like "CUS-1001"; 400 when it is malformed. */
export const parseCustomerIdParam = (value: unknown): number =>
  parsePublicIdParam('CUS', value);

/** Injects the customer number from the ":customerId" route param. */
export const CustomerNumberParam = () =>
  PublicNumberParam({ prefix: 'CUS', param: 'customerId' });
