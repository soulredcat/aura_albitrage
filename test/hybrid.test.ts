import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyzeHybrid } from '../src/bot/hybrid.service.js';
import { snapshotSchema } from '../src/domain/snapshot.validation.js';
import { d } from '../src/domain/money.js';
import { positionScore, twoSidedScore } from '../src/strategies/rewards.service.js';
import { AuraClient } from '../src/aura/aura.client.js';

const fixture = () => snapshotSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/hybrid.json', import.meta.url), 'utf8')));
const now = Date.parse('2026-09-30T14:00:00.000Z');

test('fee-inclusive pair edge, extra cost and exclusive capital allocation', () => {
  const result = analyzeHybrid(fixture(), now);
  assert.equal(result.arbitrage.conditionalProfit, '0.15');
  assert.equal(result.selectedStrategy, 'arbitrage-candidate');
  assert.equal(result.liveTradingEnabled, false);
});
test('fees eliminate an otherwise positive gross pair edge', () => {
  const s = fixture();
  s.quotes[1]!.totalCostIncludingFees = '5.5';
  assert.equal(analyzeHybrid(s, now).arbitrage.eligible, false);
});
test('partial, expired, warned and mismatched quotes are rejected', () => {
  for (const mutate of [
    (s: ReturnType<typeof fixture>) => { s.quotes[0]!.filledQuantity = '9'; },
    (s: ReturnType<typeof fixture>) => { s.quotes[0]!.expiresAt = s.observedAt; },
    (s: ReturnType<typeof fixture>) => { s.quotes[0]!.warnings = ['breaker']; },
    (s: ReturnType<typeof fixture>) => { s.quotes[0]!.bookVersion = '0'; },
    (s: ReturnType<typeof fixture>) => { s.quotes[0]!.quantity = '11'; }
  ]) {
    const s = fixture(); mutate(s);
    assert.equal(analyzeHybrid(s, now).arbitrage.eligible, false);
  }
});
test('stale/future book or qualified reward state stops planning', () => {
  assert.throws(() => analyzeHybrid(fixture(), now + 5001), /stale/);
  assert.throws(() => analyzeHybrid(fixture(), now - 1), /future/);
  const s = fixture(); s.reward.qualifiedAt = '2026-09-30T13:59:00.000Z';
  assert.throws(() => analyzeHybrid(s, now), /stale/);
});
test('maker respects direct asks and complementary bids without relying on sorting', () => {
  const s = fixture();
  s.books.no.bids.push({ price: '0.60', quantity: '100' });
  const maker = analyzeHybrid(s, now).maker;
  assert.equal(maker.orders?.find(o => o.outcome === 'yes')?.price, '0.39');
  assert.equal(maker.orders?.find(o => o.outcome === 'no')?.price, '0.5');
});
test('one-sided fill risk caps both orders and rounds quantity to lots', () => {
  const s = fixture(); s.risk.yesInventory = '13'; s.risk.lotSize = '3';
  s.reward.minIncentiveQuantity = '3';
  const maker = analyzeHybrid(s, now).maker;
  assert.equal(maker.orders?.[0]?.quantity, '6');
  assert.equal(maker.orders?.[1]?.quantity, '6');
});
test('budget reserves both orders including configured fee allowance', () => {
  const s = fixture(); s.risk.cashAvailable = '20.1';
  assert.equal(analyzeHybrid(s, now).maker.eligible, false);
  assert.equal(analyzeHybrid(s, now).arbitrage.eligible, false);
});
test('arbitrage enforces inventory exposure even if only one leg fills', () => {
  const s = fixture(); s.risk.yesInventory = '15';
  assert.equal(analyzeHybrid(s, now).arbitrage.eligible, false);
  s.risk.yesInventory = '0'; s.risk.lotSize = '3';
  assert.equal(analyzeHybrid(s, now).arbitrage.eligible, false);
});
test('reward scoring clamps eligibility and applies extreme midpoint rule', () => {
  assert.equal(positionScore(d('0.2'), d('0.1'), d('1')).toFixed(), '0');
  assert.equal(positionScore(d('0.05'), d('0.1'), d('1')).toFixed(), '0.25');
  assert.equal(twoSidedScore(d('9'), d('0'), d('0.5')).toFixed(), '3');
  assert.equal(twoSidedScore(d('9'), d('0'), d('0.09')).toFixed(), '0');
  assert.equal(twoSidedScore(d('9'), d('0'), d('0.10')).toFixed(), '3');
});
test('financial numbers and closed lifecycle fail validation', () => {
  const s = fixture();
  assert.throws(() => analyzeHybrid({ ...s, payoutPerPair: 1 }, now));
  s.tradingStatus = 'closed'; assert.throws(() => analyzeHybrid(s, now), /not open/);
});
test('decimal arithmetic retains precision above JavaScript integer range', () => {
  assert.equal(d('9007199254740993.000000000000000001').plus('0.000000000000000001').toFixed(),
    '9007199254740993.000000000000000002');
});
test('API redirects and HTML responses fail closed', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 302 });
    await assert.rejects(new AuraClient('https://api.aura.markets').readProtocolConfig(), /redirected/);
    globalThis.fetch = async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } });
    await assert.rejects(new AuraClient('https://api.aura.markets').readProtocolConfig(), /non-JSON/);
  } finally { globalThis.fetch = original; }
});
