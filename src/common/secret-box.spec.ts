import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const box = new SecretBox('x'.repeat(32), 'test-label/v1');

  it('opens what it sealed, under the same context', () => {
    const sealed = box.seal('{"token":"oc_abc"}', 'job-1');
    expect(sealed).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(sealed).not.toContain('oc_abc');
    expect(box.open(sealed, 'job-1')).toBe('{"token":"oc_abc"}');
  });

  it('seals the same text differently every time', () => {
    expect(box.seal('same', 'ctx')).not.toBe(box.seal('same', 'ctx'));
  });

  it('refuses another context, another key or label, and any change', () => {
    const sealed = box.seal('secret', 'job-1');
    expect(box.open(sealed, 'job-2')).toBeNull();
    expect(
      new SecretBox('y'.repeat(32), 'test-label/v1').open(sealed, 'job-1'),
    ).toBeNull();
    expect(
      new SecretBox('x'.repeat(32), 'other-label/v1').open(sealed, 'job-1'),
    ).toBeNull();

    const [version, iv, ciphertext, tag] = sealed.split('.');
    const flipped = `${ciphertext.slice(0, -1)}${ciphertext.endsWith('A') ? 'B' : 'A'}`;
    expect(box.open([version, iv, flipped, tag].join('.'), 'job-1')).toBeNull();
    expect(box.open(`v2.${iv}.${ciphertext}.${tag}`, 'job-1')).toBeNull();
    expect(box.open(`${sealed}.extra`, 'job-1')).toBeNull();
    expect(box.open('not sealed', 'job-1')).toBeNull();
    expect(box.open('', 'job-1')).toBeNull();
  });
});
