import type { Snapshot } from '../domain/snapshot.validation.js';
import { d } from '../domain/money.js';

export function analyzeArbitrage(s: Snapshot, now: number) {
  if (!s.binaryPayoutVerified || s.tradingStatus !== 'open')
    return { eligible: false, reason: 'binary payout or trading lifecycle is unverified' };
  const yes = s.quotes.find(q => q.outcome === 'yes');
  const no = s.quotes.find(q => q.outcome === 'no');
  if (!yes || !no) return { eligible: false, reason: 'requires fee-inclusive quotes for both outcomes' };
  for (const q of [yes, no]) {
    if (q.bookVersion !== s.bookVersion || Date.parse(q.expiresAt) <= now || q.warnings.length)
      return { eligible: false, reason: 'stale, inconsistent or warned quote' };
    if (!d(q.quantity).eq(q.filledQuantity))
      return { eligible: false, reason: 'partial execution creates directional exposure' };
  }
  if (!d(yes.quantity).eq(no.quantity))
    return { eligible: false, reason: 'pair quantities differ' };
  const quantity = d(yes.quantity);
  const imbalance = d(s.risk.yesInventory).minus(s.risk.noInventory);
  const cap = d(s.risk.maxDirectionalShares);
  if (quantity.gt(s.risk.maxOrderQuantity) || !quantity.mod(s.risk.lotSize).eq(0) ||
      imbalance.plus(quantity).abs().gt(cap) || imbalance.minus(quantity).abs().gt(cap))
    return { eligible: false, reason: 'pair violates order, lot or single-leg inventory limit' };
  const cost = d(yes.totalCostIncludingFees).plus(no.totalCostIncludingFees).plus(s.risk.extraPairCost);
  const payout = d(yes.quantity).mul(s.payoutPerPair);
  const profit = payout.minus(cost);
  const spendable = d(s.risk.cashAvailable).minus(s.risk.cashReserve);
  if (cost.gt(spendable) || cost.gt(s.risk.maxTotalSpend))
    return { eligible: false, reason: 'insufficient risk budget' };
  return {
    eligible: profit.gte(s.risk.minPairProfit),
    reason: profit.gte(s.risk.minPairProfit) ? 'positive conditional pair edge' : 'edge below threshold after costs',
    quantity: yes.quantity, totalCost: cost.toFixed(), conditionalPayout: payout.toFixed(),
    conditionalProfit: profit.toFixed(),
    executionReady: false,
    assumptions: ['both legs fill and settle', 'verified binary payout applies at resolution'],
    limitations: ['quotes do not reserve liquidity', 'multi-order execution atomicity is unverified', 'capital may remain locked until resolution']
  };
}
