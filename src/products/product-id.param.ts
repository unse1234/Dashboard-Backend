import { PublicNumberParam } from '../common/public-id.param';

/** Injects the product number from the ":productId" route param ("PRD-1001"). */
export const ProductNumberParam = () =>
  PublicNumberParam({ prefix: 'PRD', param: 'productId' });
