import { d, max, Decimal } from '../domain/money.js';
import type { PaperState, Order, Outcome } from './paper.types.js';

export const active = (order: Order) => ['accepted', 'open', 'partially-filled'].includes(order.state);
export function pendingQuantity(state: PaperState, outcome: Outcome, side: 'buy' | 'sell') {
  return state.fills.filter(f => f.state === 'provisional' && f.outcome === outcome && f.side === side)
    .reduce((sum, f) => sum.plus(f.quantity), d('0'));
}
export function cashHeld(state: PaperState, feeFraction: string) {
  const orders = state.orders.filter(o => active(o) && o.side === 'buy')
    .reduce((sum, o) => sum.plus(d(o.remaining).mul(o.price).mul(d('1').plus(feeFraction))), d('0'));
  return state.fills.filter(f => f.state === 'provisional' && f.side === 'buy')
    .reduce((sum, f) => sum.plus(f.cashAmount), orders);
}
export function spendableCash(state: PaperState, fee: string) { return d(state.cash).minus(cashHeld(state, fee)); }
export function sellable(state: PaperState, outcome: Outcome) {
  const held = state.orders.filter(o => active(o) && o.side === 'sell' && o.outcome === outcome)
    .reduce((sum, o) => sum.plus(o.remaining), pendingQuantity(state, outcome, 'sell'));
  return max(d('0'), d(state.positions[outcome].quantity).minus(held));
}
export function directionalExposure(state: PaperState) {
  // Pending sells are not credited until settlement; pending buys already carry risk.
  const net = d(state.positions.yes.quantity).plus(pendingQuantity(state, 'yes', 'buy'))
    .minus(state.positions.no.quantity).minus(pendingQuantity(state, 'no', 'buy'));
  const open = (outcome: Outcome, side: 'buy' | 'sell') => state.orders
    .filter(o => active(o) && o.outcome === outcome && o.side === side)
    .reduce((sum, o) => sum.plus(o.remaining), d('0'));
  return { net, upper: net.plus(open('yes', 'buy')).plus(open('no', 'sell')),
    lower: net.minus(open('no', 'buy')).minus(open('yes', 'sell')) };
}
export function markEquity(state: PaperState): Decimal {
  let equity = d(state.cash);
  for (const outcome of ['yes', 'no'] as const) {
    let quantity = d(state.positions[outcome].quantity);
    // Conservative liquidation valuation walks actual supplied direct bid depth.
    const bids = [...(state.snapshot?.books[outcome].bids ?? [])].sort((a, b) => d(b.price).cmp(a.price));
    for (const bid of bids) {
      const used = Decimal.min(quantity, d(bid.quantity));
      equity = equity.plus(used.mul(bid.price)); quantity = quantity.minus(used);
      if (quantity.eq(0)) break;
    }
  }
  // Pending buys have committed costs but are not yet credited with assets.
  for (const fill of state.fills.filter(f => f.state === 'provisional' && f.side === 'buy'))
    equity = equity.minus(fill.cashAmount);
  return equity;
}
