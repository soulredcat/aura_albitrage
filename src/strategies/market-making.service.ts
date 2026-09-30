import type { Snapshot } from '../domain/snapshot.validation.js';
import { d, min, max } from '../domain/money.js';
import { positionScore, twoSidedScore } from './rewards.service.js';

export function planMaker(s: Snapshot) {
  const r = s.risk;
  const mid = d(s.reward.adjustedYesMidpoint);
  const tick = d(r.tickSize);
  const lot = d(r.lotSize);
  const prices = {} as Record<'yes' | 'no', ReturnType<typeof d>>;
  for (const outcome of ['yes', 'no'] as const) {
    const fair = outcome === 'yes' ? mid : d('1').minus(mid);
    const oppositeBids = s.books[outcome === 'yes' ? 'no' : 'yes'].bids;
    // Protect against direct asks AND complement bids (dual-book mint matching).
    const crossingBounds = [s.books[outcome].asks.map(l => d(l.price)),
      oppositeBids.map(l => d('1').minus(l.price))].flat();
    let bid = fair.minus(r.halfSpread);
    if (crossingBounds.length) bid = min(bid, min(...crossingBounds).minus(tick));
    prices[outcome] = bid.div(tick).floor().mul(tick);
    if (prices[outcome].lte(0) || prices[outcome].gte(1))
      return { eligible: false, reason: 'no valid non-crossing quote tick' };
  }
  const imbalance = d(r.yesInventory).minus(r.noInventory);
  const cap = d(r.maxDirectionalShares);
  if (imbalance.abs().gt(cap)) return { eligible: false, reason: 'inventory already exceeds directional cap' };
  const available = max(d('0'), d(r.cashAvailable).minus(r.cashReserve));
  const budget = min(available, d(r.maxTotalSpend));
  const unitCost = prices.yes.plus(prices.no).mul(d('1').plus(r.feeReserveFraction));
  const quantity = min(d(r.maxOrderQuantity), cap.minus(imbalance), cap.plus(imbalance),
    budget.div(unitCost)).div(lot).floor().mul(lot);
  if (quantity.lt(s.reward.minIncentiveQuantity) || quantity.lte(0))
    return { eligible: false, reason: 'risk budget or inventory limit is below incentive floor' };
  const one = positionScore(mid.minus(prices.yes).abs(), d(s.reward.maxDistance), d(s.reward.multiplier)).mul(quantity);
  const two = positionScore(d('1').minus(mid).minus(prices.no).abs(), d(s.reward.maxDistance), d(s.reward.multiplier)).mul(quantity);
  const score = twoSidedScore(one, two, mid);
  return {
    eligible: score.gt(0), reason: score.gt(0) ? 'balanced complement BUY quote plan' : 'quotes outside incentive range',
    orders: (['yes', 'no'] as const).map(outcome => ({ outcome, side: 'buy',
      price: prices[outcome].toFixed(), quantity: quantity.toFixed() })),
    reservedBudgetEstimate: unitCost.mul(quantity).toFixed(),
    instantaneousScoreEstimate: score.toFixed(), estimatedReward: null,
    executionReady: false,
    limitations: ['adjusted midpoint and incentive parameters require a verified qualified feed',
      'fee reserve is a risk setting, not an Aura fee calculation',
      'reward depends on epoch sampling, competitors and actual pool',
      'both orders can fill; score is not profit']
  };
}
