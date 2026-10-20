import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Authenticated encryption (AES-256-GCM) for a small secret the server has to
 * read back later, such as a link token waiting in the email outbox. The key is
 * derived (HKDF) from the server's own secret under a label of its own, like the
 * quote-token key, so it is never a key used for anything else.
 *
 * Every sealed value is bound to a `context` (authenticated, not encrypted): a
 * value moved to another row does not open there. Opening a value that was
 * changed, sealed under another context, or sealed with another key returns
 * null rather than throwing.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string, label: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'ecom-dash', label, 32));
  }

  /** "v1.<iv>.<ciphertext>.<tag>", each part base64url. */
  seal(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [VERSION, iv, ciphertext, cipher.getAuthTag()]
      .map((part) =>
        typeof part === 'string' ? part : part.toString('base64url'),
      )
      .join('.');
  }

  open(sealed: string, context: string): string | null {
    const [version, iv, ciphertext, tag, ...rest] = sealed.split('.');
    if (version !== VERSION || rest.length > 0 || !iv || !tag) return null;
    try {
      const ivBytes = Buffer.from(iv, 'base64url');
      const tagBytes = Buffer.from(tag, 'base64url');
      if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
        return null;
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, ivBytes);
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(tagBytes);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext ?? '', 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}
