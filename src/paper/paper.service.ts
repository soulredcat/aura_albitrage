import { createHash } from 'node:crypto';
import { analyzeHybrid } from '../bot/hybrid.service.js';
import { d, min } from '../domain/money.js';
import { PaperRepository } from '../storage/paper.repository.js';
import { eventSchema, type PaperConfig, type PaperEvent } from './paper.validation.js';
import type { PaperState, Outcome } from './paper.types.js';
import { active, spendableCash, pendingQuantity, markEquity, cashHeld, sellable, directionalExposure } from './account.service.js';
import { PaperExecution } from './execution.service.js';
import { positionScore, twoSidedScore } from '../strategies/rewards.service.js';

export class PaperService {
  private state: PaperState;
  private readonly seen: Map<string, string>;
  private readonly execution: PaperExecution;
  constructor(private readonly config: PaperConfig, private readonly repository: PaperRepository) {
    const { events: _events, database: _database, ...settings } = config;
    const configHash = createHash('sha256').update(JSON.stringify({ engineVersion: 'paper-v1', ...settings })).digest('hex');
    const initial: PaperState = { schemaVersion: 1, runId: config.runId, configHash, revision: 0,
      cash: config.initialCash, initialCash: config.initialCash, realizedPnl: '0',
      positions: { yes: { quantity: '0', cost: '0' }, no: { quantity: '0', cost: '0' } },
      orders: [], fills: [], snapshot: null, marketId: null, lastAt: null, heartbeatAt: null,
      paused: false, stopped: false, pauseReason: null, nextOrder: 1, nextFill: 1,
      rewardScoreMs: '0', decisions: [] };
    repository.initialize(initial);
    this.state = repository.load()!;
    if (this.state.schemaVersion !== 1 || this.state.runId !== config.runId || this.state.configHash !== configHash)
      throw new Error('Database belongs to a different run or configuration; use a separate database');
    this.seen = repository.loadEventHashes();
    this.execution = new PaperExecution(config);
    this.assertInvariants(this.state);
  }
  getState() { return structuredClone(this.state); }
  report() {
    const state = this.state;
    return { mode: 'paper', liveTradingEnabled: false, runId: state.runId, revision: state.revision,
      paused: state.paused, stopped: state.stopped, pauseReason: state.pauseReason,
      cash: state.cash, heldCash: cashHeld(state, this.config.feeFraction).toFixed(),
      spendableCash: spendableCash(state, this.config.feeFraction).toFixed(), positions: state.positions,
      realizedPnl: state.realizedPnl, conservativeLiquidationEquity: markEquity(state).toFixed(),
      rewardScoreMs: state.rewardScoreMs, rewardPayout: null,
      openOrders: state.orders.filter(active), fills: state.fills, decisions: state.decisions,
      limitations: ['synthetic direct-book execution; complement matching is not simulated',
        'maker queue is a configurable scenario approximation, not actual queue reconstruction',
        'paper fees and settlement delays are scenario settings, not verified Aura parameters',
        'reward score-time is not normalized against other makers and is not an expected payout'] };
  }
  process(input: unknown) {
    const event = eventSchema.parse(input), hash = PaperRepository.hash(event);
    const prior = this.seen.get(event.id);
    if (prior) {
      if (prior !== hash) throw new Error('Event ID reused with different content');
      return false;
    }
    const at = Date.parse(event.at);
    if (this.state.lastAt !== null && at < this.state.lastAt) throw new Error('Events must be in chronological order');
    const next = structuredClone(this.state);
    this.accrueRewards(next, at);
    next.lastAt = at;
    // Failure at the settlement timestamp wins before automatic settlement.
    if (event.type === 'settlement-failed') {
      const fill = next.fills.find(f => f.id === event.fillId);
      if (!fill || fill.state !== 'provisional') throw new Error('Failure must reference a provisional fill');
      fill.state = 'funding-failed';
      this.pause(next, 'settlement-failed');
    }
    this.execution.settle(next, at);
    for (const order of next.orders.filter(active)) if (order.expiresAt <= at) order.state = 'expired';
    if (next.heartbeatAt !== null && at - next.heartbeatAt >= this.config.deadManTimeoutMs)
      this.pause(next, 'dead-man-timeout');
    switch (event.type) {
      case 'snapshot': this.snapshot(next, event, at); break;
      case 'sell-flow':
        if (!next.paused && !next.stopped && this.fresh(next, at)) {
          this.execution.activate(next, at);
          this.execution.sellFlow(next, event.outcome, event.quantity, event.limitPrice, at);
        } else this.pause(next, 'flow-without-fresh-active-book');
        break;
      case 'heartbeat': next.heartbeatAt = at; break;
      case 'disconnect': this.pause(next, 'disconnect'); break;
      case 'shutdown': next.stopped = true; this.pause(next, 'shutdown'); break;
      case 'resolution': {
        if (!next.snapshot?.binaryPayoutVerified || next.fills.some(f => f.state === 'provisional'))
          throw new Error('Resolution requires verified binary payout and no pending settlements');
        if (next.stopped) throw new Error('Run has already stopped');
        this.execution.cancel(next, 'resolution');
        const payout = d(next.positions[event.winner].quantity);
        const cost = d(next.positions.yes.cost).plus(next.positions.no.cost);
        next.cash = d(next.cash).plus(payout).toFixed();
        next.realizedPnl = d(next.realizedPnl).plus(payout.minus(cost)).toFixed();
        next.positions = { yes: { quantity: '0', cost: '0' }, no: { quantity: '0', cost: '0' } };
        next.stopped = true; next.paused = true; next.pauseReason = 'resolved'; break;
      }
      case 'resume':
        if (next.stopped) throw new Error('A stopped run cannot resume; start a new run');
        if (next.pauseReason === 'loss-limit') throw new Error('Loss-limit pause cannot be overridden in this run');
        next.paused = false; next.pauseReason = null; next.heartbeatAt = at; break;
      case 'settlement-failed': break;
    }
    if (!next.paused && !next.stopped) {
      if (!this.fresh(next, at)) this.pause(next, 'stale-book');
      else this.execution.activate(next, at);
    }
    if (next.snapshot && d(next.initialCash).minus(markEquity(next)).gte(this.config.maxLoss))
      this.pause(next, 'loss-limit');
    this.assertInvariants(next);
    next.revision++;
    // Persist state and event identity atomically before installing the new cache.
    this.repository.commit(this.state.revision, next, event);
    this.state = next; this.seen.set(event.id, hash);
    return true;
  }
  private fresh(state: PaperState, at: number) {
    if (!state.snapshot || state.snapshot.tradingStatus !== 'open') return false;
    return [state.snapshot.observedAt, state.snapshot.reward.qualifiedAt]
      .every(date => at >= Date.parse(date) && at - Date.parse(date) <= state.snapshot!.risk.maxAgeMs);
  }
  private pause(state: PaperState, reason: string) {
    if (!state.paused || state.pauseReason !== reason) {
      this.execution.cancel(state, reason); state.paused = true; state.pauseReason = reason;
    }
  }
  private snapshot(state: PaperState, event: Extract<PaperEvent, { type: 'snapshot' }>, at: number) {
    const snapshot = structuredClone(event.snapshot);
    if (snapshot.source !== 'fixture') throw new Error('Paper replay only accepts explicit fixture snapshots');
    if (state.marketId && state.marketId !== snapshot.marketId) throw new Error('One paper run supports one market; use separate runs');
    if (state.snapshot && BigInt(snapshot.bookVersion) <= BigInt(state.snapshot.bookVersion))
      throw new Error('Snapshot bookVersion must increase');
    state.marketId = snapshot.marketId; state.snapshot = snapshot;
    if (snapshot.observedAt !== event.at) throw new Error('Replay snapshot timestamp must equal its event timestamp');
    if (state.paused || state.stopped) return;
    if (d(state.initialCash).minus(markEquity(state)).gte(this.config.maxLoss)) {
      this.pause(state, 'loss-limit'); return;
    }
    state.heartbeatAt = at;
    if (!this.fresh(state, at)) { this.pause(state, 'stale-or-closed-book'); return; }
    this.execution.activate(state, at);
    // Evaluate replacement plans with existing maker reservations released in a clone.
    // Actual orders keep their queue positions unless cancellation/replacement is needed.
    const planning = structuredClone(state);
    for (const order of planning.orders.filter(o => active(o) && o.purpose === 'maker')) order.state = 'cancelled';
    snapshot.risk.cashAvailable = spendableCash(planning, this.config.feeFraction).toFixed();
    snapshot.risk.yesInventory = d(state.positions.yes.quantity).plus(pendingQuantity(state, 'yes', 'buy')).toFixed();
    snapshot.risk.noInventory = d(state.positions.no.quantity).plus(pendingQuantity(state, 'no', 'buy')).toFixed();
    snapshot.risk.feeReserveFraction = this.config.feeFraction;
    const result = analyzeHybrid(snapshot, at);
    const busy = state.orders.some(o => active(o) && o.purpose !== 'maker') || state.fills.some(f => f.state === 'provisional');
    if (busy) return;
    const imbalance = d(state.positions.yes.quantity).minus(state.positions.no.quantity);
    if (this.config.unwindInventory && !imbalance.eq(0)) {
      this.execution.cancel(state, 'inventory-unwind');
      const outcome: Outcome = imbalance.gt(0) ? 'yes' : 'no';
      const bids = [...snapshot.books[outcome].bids].sort((a, b) => d(b.price).cmp(a.price));
      const bid = bids[0];
      const qty = min(imbalance.abs(), sellable(state, outcome), d(snapshot.risk.maxOrderQuantity))
        .div(snapshot.risk.lotSize).floor().mul(snapshot.risk.lotSize);
      if (bid && qty.gt(0)) this.execution.place(state, { outcome, side: 'sell', price: bid.price,
        quantity: qty.toFixed(), purpose: 'unwind', group: event.id }, at);
      state.decisions.push({ at, action: 'inventory-unwind', reason: bid ? 'reduce unpaired inventory' : 'no bid liquidity; no order submitted' });
      return;
    }
    if (result.arbitrage.eligible && result.arbitrage.quantity) {
      this.execution.cancel(state, 'arbitrage-selected');
      // Paper execution uses actual supplied depth and scenario fees, never fixture quote costs as fills.
      const quantities = result.arbitrage.quantity;
      const plans = (['yes', 'no'] as const).map(outcome => {
        let remaining = d(quantities), cost = d('0'), worst = d('0');
        for (const level of [...snapshot.books[outcome].asks].sort((a, b) => d(a.price).cmp(b.price))) {
          const used = min(remaining, d(level.quantity)); cost = cost.plus(used.mul(level.price));
          if (used.gt(0)) worst = d(level.price); remaining = remaining.minus(used); if (remaining.eq(0)) break;
        }
        return { outcome, price: worst.toFixed(), cost, remaining };
      });
      if (plans.some(p => p.remaining.gt(0))) {
        state.decisions.push({ at, action: 'skip-arbitrage', reason: 'insufficient direct ask depth' }); return;
      }
      const pairCost = plans.reduce((sum, p) => sum.plus(p.cost.mul(d('1').plus(this.config.feeFraction))), d('0')).plus(snapshot.risk.extraPairCost);
      const reservedCost = plans.reduce((sum, p) => sum.plus(d(quantities).mul(p.price).mul(d('1').plus(this.config.feeFraction))), d('0'));
      if (d(quantities).minus(pairCost).lt(snapshot.risk.minPairProfit) || pairCost.gt(snapshot.risk.maxTotalSpend) ||
          reservedCost.gt(spendableCash(state, this.config.feeFraction).minus(snapshot.risk.cashReserve))) {
        state.decisions.push({ at, action: 'skip-arbitrage', reason: 'scenario execution costs exceed edge or budget' }); return;
      }
      for (const plan of plans) this.execution.place(state, { ...plan, side: 'buy', quantity: quantities,
        purpose: 'arbitrage', group: event.id }, at);
      state.decisions.push({ at, action: 'arbitrage', reason: 'positive pair edge at supplied direct-book depth; both legs remain independently executable' });
      return;
    }
    if (result.maker.eligible && result.maker.orders) {
      const existing = state.orders.filter(active);
      const unchanged = existing.length === 2 && result.maker.orders.every(plan => existing.some(o =>
        o.purpose === 'maker' && o.outcome === plan.outcome && o.price === plan.price &&
        d(o.remaining).lte(plan.quantity) && o.expiresAt - at > this.config.submitLatencyMs));
      if (unchanged) return;
      this.execution.cancel(state, 'maker-reprice');
      for (const plan of result.maker.orders) this.execution.place(state, { ...plan, side: 'buy', purpose: 'maker', group: event.id }, at);
      state.decisions.push({ at, action: 'maker', reason: 'rest complementary bids under inventory and cash limits' });
    } else this.execution.cancel(state, 'no-eligible-plan');
  }
  private accrueRewards(state: PaperState, at: number) {
    if (state.lastAt === null || !state.snapshot || state.paused) return;
    const snapshot = state.snapshot, mid = d(snapshot.reward.adjustedYesMidpoint);
    let one = d('0'), two = d('0');
    const end = Math.min(at, Date.parse(snapshot.observedAt) + snapshot.risk.maxAgeMs,
      Date.parse(snapshot.reward.qualifiedAt) + snapshot.risk.maxAgeMs,
      (state.heartbeatAt ?? state.lastAt) + this.config.deadManTimeoutMs);
    for (const order of state.orders.filter(o => active(o) && o.state !== 'accepted' && o.purpose === 'maker')) {
      if (d(order.remaining).lt(snapshot.reward.minIncentiveQuantity)) continue;
      const elapsed = Math.max(0, Math.min(end, order.expiresAt) - state.lastAt);
      const fair = order.outcome === 'yes' ? mid : d('1').minus(mid);
      const points = positionScore(fair.minus(order.price).abs(), d(snapshot.reward.maxDistance), d(snapshot.reward.multiplier))
        .mul(order.remaining).mul(elapsed);
      if (order.outcome === 'yes') one = one.plus(points); else two = two.plus(points);
    }
    state.rewardScoreMs = d(state.rewardScoreMs).plus(twoSidedScore(one, two, mid)).toFixed();
  }
  private assertInvariants(state: PaperState) {
    if (d(state.cash).lt(0) || spendableCash(state, this.config.feeFraction).lt(0)) throw new Error('Negative cash invariant');
    for (const position of Object.values(state.positions))
      if (d(position.quantity).lt(0) || d(position.cost).lt(0)) throw new Error('Negative inventory invariant');
    for (const order of state.orders)
      if (d(order.remaining).lt(0) || d(order.remaining).gt(order.quantity)) throw new Error('Invalid order remainder');
    if (state.snapshot && !state.paused) {
      const exposure = directionalExposure(state), limit = d(state.snapshot.risk.maxDirectionalShares);
      if (exposure.upper.gt(limit) || exposure.lower.lt(limit.neg())) throw new Error('Directional exposure invariant');
    }
  }
}
