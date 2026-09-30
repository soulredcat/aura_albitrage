import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { quoteRequestSchema, quoteResponseSchema } from '../src/aura/quote.validation.js';
import { verifyReceipt, receiptKeySchema } from '../src/aura/receipt.service.js';
import { AuraClient } from '../src/aura/aura.client.js';

test('receipt record is a public signing key, not a wallet credential', () => {
  assert.throws(() => receiptKeySchema.parse({ keyId: 2147483647, algorithm: 'Ed25519', publicKeySpkiHex: '<string>' }));
  const keys = generateKeyPairSync('ed25519');
  const record = { keyId: 1, algorithm: 'Ed25519', publicKeySpkiHex: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('hex') };
  const payload = Buffer.from('canonical receipt test bytes');
  const signature = sign(null, payload, keys.privateKey).toString('hex');
  assert.equal(verifyReceipt(record, 1, payload, signature), true);
  assert.equal(verifyReceipt(record, 1, Buffer.from('tampered'), signature), false);
  assert.throws(() => verifyReceipt(record, 2, payload, signature), /key ID mismatch/);
});
test('quote request enforces semantic BUY/SELL amount and bound rules', () => {
  const request = { outcome: 'yes', side: 'buy', orderType: 'gtc_limit', quantityBaseUnits: '100', limitPriceTick: 450 };
  assert.equal(quoteRequestSchema.parse(request).quantityBaseUnits, '100');
  assert.throws(() => quoteRequestSchema.parse({ ...request, spendBaseUnits: '100' }));
  assert.throws(() => quoteRequestSchema.parse({ ...request, quantityBaseUnits: 100 }));
  assert.throws(() => quoteRequestSchema.parse({ ...request, quantityBaseUnits: '0' }));
  assert.throws(() => quoteRequestSchema.parse({ ...request, side: 'sell', orderType: 'ioc_market' }));
});
test('API client sends quote POST with header credentials and validates exact string amounts', async () => {
  const original = globalThis.fetch;
  const address = '1'.repeat(30);
  const payload = { marketAddress: address, marketId: 'a'.repeat(64), bookVersion: '1', streamCursor: 'rt2.test',
    quotedAt: '2026-09-30T14:00:00.000Z', expiresAt: '2026-09-30T14:00:10.000Z', guaranteed: false,
    request: { outcome: 'yes', side: 'buy', orderType: 'gtc_limit', quantityBaseUnits: '100', spendBaseUnits: null,
      limitPriceTick: 450, costBoundBaseUnits: '0', feeCapBps: 250, allowPartialFill: false, ownerSelfMatchExcluded: false },
    estimate: { fills: [{ quantityBaseUnits: '100', debitBaseUnits: '47', creditBaseUnits: '100', feeBaseUnits: '2', executionPriceTick: 450 }],
      filledQuantityBaseUnits: '100', unfilledQuantityBaseUnits: '0', requiredCollateralBaseUnits: '47', totalFeeBaseUnits: '2',
      expectedProceedsBaseUnits: '0', currentSpendableBaseUnits: null }, spendable: { status: 'unauthenticated' }, warnings: [] };
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, `/v1/markets/${address}/quote`);
      assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('x-aura-developer-key'), 'local-test-key');
      return Response.json(payload);
    };
    const client = new AuraClient('https://api.aura.markets', { developerKey: 'local-test-key' });
    assert.equal((await client.quote(address, { outcome: 'yes', side: 'buy', orderType: 'gtc_limit', quantityBaseUnits: '100', limitPriceTick: 450 })).estimate.totalFeeBaseUnits, '2');
    payload.estimate.filledQuantityBaseUnits = '99';
    await assert.rejects(client.quote(address, { outcome: 'yes', side: 'buy', orderType: 'gtc_limit', quantityBaseUnits: '100', limitPriceTick: 450 }), /inconsistent/);
    assert.throws(() => quoteResponseSchema.parse({ ...payload, guaranteed: true }));
  } finally { globalThis.fetch = original; }
});
