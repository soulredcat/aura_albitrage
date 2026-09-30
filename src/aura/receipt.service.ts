import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

export const receiptKeySchema = z.object({ keyId: z.number().int().min(0).max(4294967295),
  algorithm: z.literal('Ed25519'), publicKeySpkiHex: z.string().regex(/^[0-9a-f]{88}$/) }).strict();

// The caller must supply canonical receipt bytes and a key trusted/pinned independently.
// Do not JSON.stringify a receipt or interpret a valid signature as settled execution.
export function verifyReceipt(keyRecord: unknown, expectedKeyId: number, payload: Uint8Array, signatureHex: string) {
  const record = receiptKeySchema.parse(keyRecord);
  if (record.keyId !== expectedKeyId) throw new Error('Receipt signing key ID mismatch');
  if (!/^[0-9a-f]{128}$/.test(signatureHex)) throw new Error('Invalid Ed25519 signature encoding');
  const key = createPublicKey({ key: Buffer.from(record.publicKeySpkiHex, 'hex'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 public key');
  return verify(null, payload, key, Buffer.from(signatureHex, 'hex'));
}
