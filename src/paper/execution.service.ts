import { d, min } from '../domain/money.js';
import type { PaperConfig } from './paper.validation.js';
import type { PaperState, Order, Outcome, Fill } from './paper.types.js';
import { active, spendableCash, sellable, directionalExposure } from './account.service.js';

export class PaperExecution {
  constructor(private readonly config: PaperConfig) {}
  cancel(state: PaperState, reason: string) {
    for (const order of state.orders.filter(active)) order.state = 'cancelled';
    state.decisions.push({ at: state.lastAt ?? 0, action: 'cancel-open', reason });
  }
  place(state: PaperState, args: Pick<Order, 'outcome' | 'side' | 'price' | 'quantity' | 'purpose' | 'group'>, at: number) {
    const snapshot = state.snapshot;
    if (!snapshot || state.paused || state.stopped) throw new Error('Execution is paused or lacks a snapshot');
    const qty = d(args.quantity), price = d(args.price), risk = snapshot.risk;
    if (qty.lte(0) || price.lte(0) || price.gte(1) || qty.gt(risk.maxOrderQuantity) ||
        !qty.mod(risk.lotSize).eq(0) || !price.mod(risk.tickSize).eq(0)) throw new Error('Invalid paper order bounds');
    const cost = qty.mul(price).mul(d('1').plus(this.config.feeFraction));
    if (args.side === 'buy' && cost.gt(spendableCash(state, this.config.feeFraction).minus(risk.cashReserve)))
      throw new Error('Paper order exceeds spendable cash');
    if (args.side === 'sell' && qty.gt(sellable(state, args.outcome))) throw new Error('Paper order exceeds sellable shares');
    const exposure = directionalExposure(state);
    const increases = (args.outcome === 'yes' && args.side === 'buy') || (args.outcome === 'no' && args.side === 'sell');
    const worst = increases ? exposure.upper.plus(qty) : exposure.lower.minus(qty);
    if (args.purpose !== 'unwind' && worst.abs().gt(risk.maxDirectionalShares)) throw new Error('Paper order exceeds inventory exposure');
    const order: Order = { outcome: args.outcome, side: args.side, price: args.price, quantity: args.quantity,
      purpose: args.purpose, group: args.group, id: `${state.runId}:order:${state.nextOrder++}`, remaining: args.quantity,
      state: 'accepted', acceptedAt: at, activateAt: at + this.config.submitLatencyMs,
      expiresAt: at + this.config.orderLifetimeMs, queueAhead: '0' };
    state.orders.push(order);
    return order;
  }
  private match(state: PaperState, order: Order, quantity: string, price: string, at: number) {
    const notional = d(quantity).mul(price), fee = notional.mul(this.config.feeFraction);
    const fill: Fill = { id: `${state.runId}:fill:${state.nextFill++}`, orderId: order.id,
      outcome: order.outcome, side: order.side, quantity, price, fee: fee.toFixed(),
      cashAmount: (order.side === 'buy' ? notional.plus(fee) : notional.minus(fee)).toFixed(),
      state: 'provisional', settleAt: at + this.config.settlementLatencyMs };
    state.fills.push(fill);
    order.remaining = d(order.remaining).minus(quantity).toFixed();
    order.state = d(order.remaining).eq(0) ? 'filled' : 'partially-filled';
  }
  activate(state: PaperState, at: number) {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    // Shared per-tick depth prevents separate orders from consuming the same liquidity.
    const books = structuredClone(snapshot.books);
    for (const order of state.orders.filter(o => o.state === 'accepted' && o.activateAt <= at)) {
      if (order.expiresAt <= at) { order.state = 'expired'; continue; }
      if (snapshot.tradingStatus !== 'open' || at - Date.parse(snapshot.observedAt) > snapshot.risk.maxAgeMs) {
        order.state = 'rejected'; continue;
      }
      if (order.purpose === 'maker') {
        const directCross = books[order.outcome].asks.some(l => d(l.price).lte(order.price));
        const other = order.outcome === 'yes' ? 'no' : 'yes';
        const complementCross = books[other].bids.some(l => d('1').minus(l.price).lte(order.price));
        if (directCross || complementCross) { order.state = 'rejected'; continue; }
        order.queueAhead = books[order.outcome].bids.filter(l => d(l.price).gte(order.price))
          .reduce((sum, l) => sum.plus(l.quantity), d('0')).toFixed();
        order.state = 'open'; continue;
      }
      const levels = order.side === 'buy' ? books[order.outcome].asks : books[order.outcome].bids;
      levels.sort((a, b) => order.side === 'buy' ? d(a.price).cmp(b.price) : d(b.price).cmp(a.price));
      for (const level of levels) {
        if (order.side === 'buy' ? d(level.price).gt(order.price) : d(level.price).lt(order.price)) break;
        const quantity = min(d(level.quantity), d(order.remaining)).div(snapshot.risk.lotSize).floor().mul(snapshot.risk.lotSize);
        if (quantity.lte(0)) continue;
        this.match(state, order, quantity.toFixed(), level.price, at);
        level.quantity = d(level.quantity).minus(quantity).toFixed();
        if (d(order.remaining).eq(0)) break;
      }
      // Taker/unwind intents are IOC: unfilled remainder is cancelled.
      if (d(order.remaining).gt(0)) order.state = 'cancelled';
      else if (order.state === 'accepted') order.state = 'cancelled';
    }
  }
  sellFlow(state: PaperState, outcome: Outcome, quantity: string, limitPrice: string, at: number) {
    let remaining = d(quantity);
    const orders = state.orders.filter(o => active(o) && o.state !== 'accepted' && o.purpose === 'maker' &&
      o.outcome === outcome && o.side === 'buy' && d(o.price).gte(limitPrice))
      .sort((a, b) => d(b.price).cmp(a.price) || a.acceptedAt - b.acceptedAt);
    for (const order of orders) {
      const ahead = min(remaining, d(order.queueAhead));
      order.queueAhead = d(order.queueAhead).minus(ahead).toFixed(); remaining = remaining.minus(ahead);
      const fillQty = min(remaining, d(order.remaining)).div(state.snapshot!.risk.lotSize).floor().mul(state.snapshot!.risk.lotSize);
      if (fillQty.gt(0)) { this.match(state, order, fillQty.toFixed(), order.price, at); remaining = remaining.minus(fillQty); }
      if (remaining.eq(0)) break;
    }
  }
  settle(state: PaperState, at: number) {
    for (const fill of state.fills.filter(f => f.state === 'provisional' && f.settleAt <= at)) {
      const position = state.positions[fill.outcome];
      if (fill.side === 'buy') {
        if (d(fill.cashAmount).gt(state.cash)) { fill.state = 'funding-failed'; continue; }
        state.cash = d(state.cash).minus(fill.cashAmount).toFixed();
        position.quantity = d(position.quantity).plus(fill.quantity).toFixed();
        position.cost = d(position.cost).plus(fill.cashAmount).toFixed();
      } else {
        if (d(fill.quantity).gt(position.quantity)) { fill.state = 'funding-failed'; continue; }
        const basis = d(position.cost).mul(fill.quantity).div(position.quantity);
        position.quantity = d(position.quantity).minus(fill.quantity).toFixed();
        position.cost = d(position.cost).minus(basis).toFixed();
        state.cash = d(state.cash).plus(fill.cashAmount).toFixed();
        state.realizedPnl = d(state.realizedPnl).plus(d(fill.cashAmount).minus(basis)).toFixed();
      }
      fill.state = 'settled';
    }
  }
}
