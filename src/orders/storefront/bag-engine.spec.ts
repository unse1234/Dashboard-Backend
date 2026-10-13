import {
  applyBagAction,
  assertValidBag,
  BagRuleError,
  type BagLine,
} from './bag-engine';

const bag: BagLine[] = [
  { number: 1001, quantity: 2 },
  { number: 1002, quantity: 1 },
];

describe('assertValidBag', () => {
  it('accepts an empty bag and a normal one', () => {
    expect(assertValidBag([])).toEqual([]);
    expect(assertValidBag(bag)).toEqual(bag);
  });

  it('refuses a product that appears twice', () => {
    expect(() =>
      assertValidBag([
        { number: 1001, quantity: 1 },
        { number: 1001, quantity: 2 },
      ]),
    ).toThrow(BagRuleError);
  });

  it.each([0, -1, 1.5, 1001, Number.NaN])('refuses quantity %p', (quantity) => {
    expect(() => assertValidBag([{ number: 1001, quantity }])).toThrow(
      BagRuleError,
    );
  });

  it('accepts the quantity limits and refuses more than 100 lines', () => {
    expect(() => assertValidBag([{ number: 1, quantity: 1000 }])).not.toThrow();
    const lines = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      quantity: 1,
    }));
    expect(() => assertValidBag(lines)).not.toThrow();
    expect(() =>
      assertValidBag([...lines, { number: 101, quantity: 1 }]),
    ).toThrow(BagRuleError);
  });
});

describe('applyBagAction', () => {
  it('adds a new product at the end, one by default', () => {
    const result = applyBagAction(bag, { type: 'add', number: 1003 });
    expect(result.lines).toEqual([...bag, { number: 1003, quantity: 1 }]);
    expect(result.raised).toEqual({ number: 1003, quantity: 1 });
  });

  it('merges an added product into its line, keeping its place', () => {
    const result = applyBagAction(bag, {
      type: 'add',
      number: 1001,
      quantity: 3,
    });
    expect(result.lines).toEqual([
      { number: 1001, quantity: 5 },
      { number: 1002, quantity: 1 },
    ]);
    expect(result.raised).toEqual({ number: 1001, quantity: 5 });
  });

  it('increments by one, and creates the line when it is absent', () => {
    expect(
      applyBagAction(bag, { type: 'increment', number: 1002 }).lines,
    ).toEqual([
      { number: 1001, quantity: 2 },
      { number: 1002, quantity: 2 },
    ]);
    expect(
      applyBagAction(bag, { type: 'increment', number: 1009 }).lines,
    ).toEqual([...bag, { number: 1009, quantity: 1 }]);
  });

  it('decrements, and removes a line that would reach zero', () => {
    expect(
      applyBagAction(bag, { type: 'decrement', number: 1001 }).lines,
    ).toEqual([
      { number: 1001, quantity: 1 },
      { number: 1002, quantity: 1 },
    ]);
    const removed = applyBagAction(bag, { type: 'decrement', number: 1002 });
    expect(removed.lines).toEqual([{ number: 1001, quantity: 2 }]);
    expect(removed.raised).toBeNull();
  });

  it('sets an exact quantity, creating the line when it is absent', () => {
    expect(
      applyBagAction(bag, { type: 'set', number: 1001, quantity: 7 }).lines,
    ).toEqual([
      { number: 1001, quantity: 7 },
      { number: 1002, quantity: 1 },
    ]);
    expect(
      applyBagAction(bag, { type: 'set', number: 1005, quantity: 4 }).lines,
    ).toEqual([...bag, { number: 1005, quantity: 4 }]);
  });

  it('removes a line, and leaves others alone', () => {
    expect(applyBagAction(bag, { type: 'remove', number: 1001 }).lines).toEqual(
      [{ number: 1002, quantity: 1 }],
    );
  });

  it('is harmless to decrement or remove a product that is not in the bag', () => {
    expect(
      applyBagAction(bag, { type: 'decrement', number: 9999 }).lines,
    ).toEqual(bag);
    expect(applyBagAction(bag, { type: 'remove', number: 9999 }).lines).toEqual(
      bag,
    );
  });

  it('does not change the bag it was given', () => {
    const before = JSON.stringify(bag);
    applyBagAction(bag, { type: 'add', number: 1001, quantity: 9 });
    applyBagAction(bag, { type: 'remove', number: 1001 });
    expect(JSON.stringify(bag)).toBe(before);
  });

  it('refuses to go past the quantity limit, however it gets there', () => {
    const full: BagLine[] = [{ number: 1001, quantity: 1000 }];
    expect(() =>
      applyBagAction(full, { type: 'increment', number: 1001 }),
    ).toThrow(BagRuleError);
    expect(() =>
      applyBagAction(full, { type: 'add', number: 1001, quantity: 1 }),
    ).toThrow(BagRuleError);
    expect(() =>
      applyBagAction(bag, { type: 'set', number: 1001, quantity: 1001 }),
    ).toThrow(BagRuleError);
    expect(() =>
      applyBagAction(bag, { type: 'set', number: 1001, quantity: 0 }),
    ).toThrow(BagRuleError);
  });

  it('refuses a set without a quantity, and a quantity where none belongs', () => {
    expect(() => applyBagAction(bag, { type: 'set', number: 1001 })).toThrow(
      BagRuleError,
    );
    for (const type of ['increment', 'decrement', 'remove'] as const) {
      expect(() =>
        applyBagAction(bag, { type, number: 1001, quantity: 2 }),
      ).toThrow(BagRuleError);
    }
  });

  it('refuses a 101st line', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      quantity: 1,
    }));
    expect(() => applyBagAction(lines, { type: 'add', number: 500 })).toThrow(
      BagRuleError,
    );
    // An existing line can still grow.
    expect(() =>
      applyBagAction(lines, { type: 'increment', number: 1 }),
    ).not.toThrow();
  });
});
