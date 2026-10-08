import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeAll(async () => {
    service = new PasswordService();
    await service.onModuleInit();
  });

  it('hashes with Argon2id and a unique salt', async () => {
    const a = await service.hash('Correct-Horse-1');
    const b = await service.hash('Correct-Horse-1');
    expect(a).toMatch(/^\$argon2id\$v=19\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('Correct-Horse-1');
  });

  it('verifies the right password and rejects wrong ones', async () => {
    const hash = await service.hash('Correct-Horse-1');
    await expect(service.verify(hash, 'Correct-Horse-1')).resolves.toBe(true);
    await expect(service.verify(hash, 'correct-horse-1')).resolves.toBe(false);
    await expect(service.verify(hash, '')).resolves.toBe(false);
  });

  it('never matches without a stored hash, yet still spends real hashing time', async () => {
    // A skipped verification would return in microseconds; Argon2id at the
    // default cost takes tens of milliseconds, so this detects the shortcut.
    const started = performance.now();
    await expect(service.verify(null, 'anything')).resolves.toBe(false);
    expect(performance.now() - started).toBeGreaterThan(10);
  });

  it('treats a corrupt hash as a mismatch instead of throwing', async () => {
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
  });
});
