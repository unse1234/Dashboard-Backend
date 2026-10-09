import { escapeLike } from './like.util';

describe('escapeLike', () => {
  it('escapes the LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\now')).toBe('50\\%\\_off\\\\now');
  });

  it('leaves other text alone', () => {
    expect(escapeLike('Ada Lovelace')).toBe('Ada Lovelace');
  });
});
