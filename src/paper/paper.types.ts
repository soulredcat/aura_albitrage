import type { Snapshot } from '../domain/snapshot.validation.js';

export type Outcome = 'yes' | 'no';
export type Order = {
  id: string; group: string; purpose: 'maker' | 'arbitrage' | 'unwind';
  outcome: Outcome; side: 'buy' | 'sell'; price: string; quantity: string; remaining: string;
  state: 'accepted' | 'open' | 'partially-filled' | 'filled' | 'cancelled' | 'expired' | 'rejected';
  acceptedAt: number; activateAt: number; expiresAt: number; queueAhead: string;
};
export type Fill = {
  id: string; orderId: string; outcome: Outcome; side: 'buy' | 'sell';
  quantity: string; price: string; fee: string; cashAmount: string;
  state: 'provisional' | 'settled' | 'funding-failed'; settleAt: number;
};
export type Position = { quantity: string; cost: string };
export type PaperState = {
  schemaVersion: 1; runId: string; configHash: string; revision: number;
  cash: string; initialCash: string; realizedPnl: string;
  positions: Record<Outcome, Position>; orders: Order[]; fills: Fill[];
  marketId: string | null; snapshot: Snapshot | null; lastAt: number | null;
  heartbeatAt: number | null; paused: boolean; stopped: boolean; pauseReason: string | null;
  nextOrder: number; nextFill: number; rewardScoreMs: string;
  decisions: { at: number; action: string; reason: string }[];
};
