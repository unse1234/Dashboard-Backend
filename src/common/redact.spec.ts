import { diagnosticText, redactSecrets } from './redact';

const TOKEN = `oc_${'a'.repeat(43)}`;

describe('redactSecrets', () => {
  it('removes storefront tokens wherever they appear', () => {
    expect(
      redactSecrets(
        `refused ${TOKEN} and as_${'B'.repeat(43)} and cr_${'C'.repeat(43)} and pr_${'D'.repeat(43)}`,
      ),
    ).toBe(
      'refused oc_[redacted] and as_[redacted] and cr_[redacted] and pr_[redacted]',
    );
  });

  it('removes token parameters from links, in a query or a fragment', () => {
    expect(
      redactSecrets(
        'https://shop.example/orders/confirm#token=abc123 and /reset-password?token=xyz&x=1',
      ),
    ).toBe(
      'https://shop.example/orders/confirm#token=[redacted] and /reset-password?token=[redacted]&x=1',
    );
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('550 mailbox unavailable')).toBe(
      '550 mailbox unavailable',
    );
  });
});

describe('diagnosticText', () => {
  it('redacts, flattens and truncates', () => {
    const text = diagnosticText(`line one\n\n${TOKEN}\t${'x'.repeat(600)}`, 40);
    expect(text).toHaveLength(40);
    expect(text.startsWith('line one oc_[redacted] x')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
  });
});
