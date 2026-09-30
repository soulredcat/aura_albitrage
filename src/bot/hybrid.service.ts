import { snapshotSchema } from '../domain/snapshot.validation.js';
import { d } from '../domain/money.js';
import { analyzeArbitrage } from '../strategies/arbitrage.service.js';
import { planMaker } from '../strategies/market-making.service.js';

export function analyzeHybrid(input: unknown, now = Date.now()) {
  const s = snapshotSchema.parse(input);
  for (const date of [s.observedAt, s.reward.qualifiedAt]) {
    const age = now - Date.parse(date);
    if (age < 0 || age > s.risk.maxAgeMs) throw new Error('stale or future snapshot; planning stopped');
  }
  if (s.tradingStatus !== 'open') throw new Error('market is not open');
  if (!d(s.reward.adjustedYesMidpoint).lt(1)) throw new Error('invalid midpoint');
  if (!d(s.risk.tickSize).lt(1) || d(s.risk.halfSpread).gte(1)) throw new Error('invalid pricing configuration');
  if (!d(s.payoutPerPair).eq(1)) throw new Error('normalized binary payout must be one collateral unit');
  for (const book of Object.values(s.books)) {
    for (const level of [...book.bids, ...book.asks]) {
      if (d(level.price).gte(1)) throw new Error('invalid book price');
    }
  }
  const arbitrage = analyzeArbitrage(s, now);
  const maker = planMaker(s);
  // Shared cash cannot be spent independently by both strategies.
  return { mode: 'analysis-only', source: s.source, marketId: s.marketId,
    bookVersion: s.bookVersion, arbitrage, maker,
    selectedStrategy: arbitrage.eligible ? 'arbitrage-candidate' : maker.eligible ? 'maker-plan' : 'none',
    allocationPolicy: 'exclusive strategy selection; no order submission',
    liveTradingEnabled: false };
}
