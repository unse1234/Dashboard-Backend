import { HttpStatus } from '@nestjs/common';
import { BusinessException } from '../../common/business-error';
import { parsePublicId } from '../../common/public-id';
import { assertValidBag, BagRuleError, type BagLine } from './bag-engine';

/**
 * A request's lines as product numbers, any id casing folded, and checked as a
 * bag (nothing repeated, quantities in range). A broken bag is `INVALID_BAG`.
 */
export function canonicalBag(
  items: readonly { productId: string; quantity: number }[],
): BagLine[] {
  try {
    return assertValidBag(
      items.map(({ productId, quantity }) => ({
        // The DTO has already checked that every id is well formed.
        number: parsePublicId('PRD', productId) as number,
        quantity,
      })),
    );
  } catch (error) {
    if (error instanceof BagRuleError) {
      throw new BusinessException(
        HttpStatus.BAD_REQUEST,
        'INVALID_BAG',
        error.message,
      );
    }
    throw error;
  }
}
