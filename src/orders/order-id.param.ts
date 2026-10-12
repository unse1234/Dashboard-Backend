import { PublicNumberParam } from '../common/public-id.param';

/** Injects the order number from the ":orderId" route param ("ORD-10001"). */
export const OrderNumberParam = () =>
  PublicNumberParam({ prefix: 'ORD', param: 'orderId' });
