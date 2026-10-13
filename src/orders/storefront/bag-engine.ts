import { MAX_LINE_QUANTITY, MAX_LINES } from '../dto/create-order.dto';

/** One line of a bag: a product (by number) and how many of it. */
export interface BagLine {
  number: number;
  quantity: number;
}

export const BAG_ACTION_TYPES = [
  'add',
  'increment',
  'decrement',
  'set',
  'remove',
] as const;
export type BagActionType = (typeof BAG_ACTION_TYPES)[number];

export interface BagAction {
  type: BagActionType;
  number: number;
  quantity?: number;
}

/** The bag, or an action on it, breaks a rule. The message is for people. */
export class BagRuleError extends Error {}

export interface AppliedBagAction {
  lines: BagLine[];
  /**
   * The line whose quantity the action raised (or created), with its new
   * quantity: the one thing a caller must check can actually be fulfilled.
   * Null for actions that only take away.
   */
  raised: BagLine | null;
}

/**
 * Checks a bag as it was sent: nothing repeated (a product is one line, however
 * the id was spelled), at most `MAX_LINES` lines, every quantity within bounds.
 * Returns it unchanged otherwise.
 */
export function assertValidBag(lines: readonly BagLine[]): BagLine[] {
  if (lines.length > MAX_LINES) {
    throw new BagRuleError(`A bag can hold at most ${MAX_LINES} products`);
  }
  const seen = new Set<number>();
  for (const { number, quantity } of lines) {
    if (seen.has(number)) {
      throw new BagRuleError('Each product can appear only once in a bag');
    }
    seen.add(number);
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_LINE_QUANTITY
    ) {
      throw new BagRuleError(
        `Quantity must be between 1 and ${MAX_LINE_QUANTITY}`,
      );
    }
  }
  return [...lines];
}

/**
 * Applies one action to a valid bag and returns the new bag. Pure: it knows
 * nothing about stock or prices, only the bag's own rules.
 *
 * - `add` puts `quantity` (default 1) of a product in, merging with its line.
 * - `increment` is `add` of exactly one.
 * - `set` makes the line exactly `quantity` (1 or more), creating it if absent.
 * - `decrement` takes one off; a line that reaches zero leaves the bag.
 * - `remove` deletes the line.
 *
 * `decrement` and `remove` of a product that is not in the bag change nothing,
 * so a double click is harmless. A new line goes at the end; existing lines keep
 * their place.
 */
export function applyBagAction(
  lines: readonly BagLine[],
  action: BagAction,
): AppliedBagAction {
  const { type, number } = action;
  const index = lines.findIndex((line) => line.number === number);
  const current = index === -1 ? 0 : lines[index].quantity;

  if (type !== 'add' && type !== 'set' && action.quantity !== undefined) {
    throw new BagRuleError(`A quantity is not accepted when you ${type}`);
  }

  switch (type) {
    case 'decrement': {
      if (index === -1) return { lines: [...lines], raised: null };
      const next = current - 1;
      return {
        lines:
          next < 1
            ? lines.filter((_, i) => i !== index)
            : lines.map((line, i) =>
                i === index ? { ...line, quantity: next } : line,
              ),
        raised: null,
      };
    }
    case 'remove':
      return {
        lines: lines.filter((_, i) => i !== index),
        raised: null,
      };
    case 'add':
    case 'increment':
    case 'set': {
      let next: number;
      if (type === 'set') {
        if (action.quantity === undefined) {
          throw new BagRuleError('Say what quantity to set');
        }
        next = action.quantity;
      } else {
        next = current + (type === 'add' ? (action.quantity ?? 1) : 1);
      }
      if (!Number.isInteger(next) || next < 1 || next > MAX_LINE_QUANTITY) {
        throw new BagRuleError(
          `Quantity must be between 1 and ${MAX_LINE_QUANTITY}`,
        );
      }
      if (index === -1 && lines.length >= MAX_LINES) {
        throw new BagRuleError(`A bag can hold at most ${MAX_LINES} products`);
      }
      const raised = { number, quantity: next };
      return {
        lines:
          index === -1
            ? [...lines, raised]
            : lines.map((line, i) => (i === index ? raised : line)),
        raised,
      };
    }
  }
}
