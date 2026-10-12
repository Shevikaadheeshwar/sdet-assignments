import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 over the **raw request body**, hex encoded (A2.4).
 *
 * Signing the raw bytes rather than a re-serialised object matters: JSON
 * round-tripping can reorder keys or change number formatting, and any
 * difference would either break honest deliveries or — worse — let a tampered
 * body verify against a signature computed over a normalised form.
 */
export function signBody(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Compared with `timingSafeEqual` rather than `===`, so the comparison takes the
 * same time whatever the input. A naive comparison returns early on the first
 * wrong byte, which leaks enough timing information to reconstruct a valid
 * signature one byte at a time.
 */
export function isValidSignature(
  rawBody: Buffer,
  providedSignature: string | undefined,
  secret: string,
): boolean {
  if (!providedSignature) return false;

  const expected = Buffer.from(signBody(rawBody, secret), 'utf8');
  const provided = Buffer.from(providedSignature, 'utf8');

  // timingSafeEqual throws on a length mismatch, so that is checked first. The
  // length of a signature is not a secret.
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}
