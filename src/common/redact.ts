/** Storefront link tokens: a purpose prefix and 43 base64url characters. */
const STOREFRONT_TOKEN = /\b(oc|as|cr|pr)_[A-Za-z0-9_-]{20,}/g;
/** Any "token=" value in a URL query or fragment. */
const TOKEN_PARAMETER = /([?#&]token=)[^&#\s"'<>]+/gi;

/**
 * Removes link tokens from text that is about to be logged or stored for
 * diagnosis (a mail provider's error can quote the message it refused).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(TOKEN_PARAMETER, '$1[redacted]')
    .replace(STOREFRONT_TOKEN, '$1_[redacted]');
}

/** Redacted, single-line and at most `max` characters, for a failure column. */
export function diagnosticText(text: string, max = 500): string {
  const clean = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
