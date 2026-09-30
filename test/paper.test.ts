import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaperService } from '../src/paper/paper.service.js';
import { PaperRepository } from '../src/storage/paper.repository.js';
import { paperConfigSchema, type PaperConfig, type PaperEvent } from '../src/paper/paper.validation.js';

const fixture = () => paperConfigSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/paper.json', import.meta.url), 'utf8')));
const start = Date.parse('2026-09-30T14:00:00.000Z');
const event = (ms: number, id: string, type: 'heartbeat' | 'disconnect' | 'resume' | 'shutdown'): PaperEvent =>
  ({ id, type, at: new Date(start + ms).toISOString() });
function run(config: PaperConfig, check: (service: PaperService) => void) {
  const repo = new PaperRepository(':memory:');
  try { check(new PaperService(config, repo)); } finally { repo.close(); }
}

test('full paper run settles maker fills, unwinds imbalance, executes a pair and resolves', () => {
  const config = fixture();
  run(config, service => {
    config.events.forEach(e => service.process(e));
    const result = service.report();
    assert.equal(result.cash, '100.23775'); assert.equal(result.realizedPnl, '0.23775');
    assert.equal(result.heldCash, '0'); assert.equal(result.openOrders.length, 0);
    assert.equal(result.fills.filter(f => f.state === 'settled').length, 5);
    assert.equal(result.stopped, true); assert.equal(result.rewardPayout, null);
  });
});
test('restart recovery and duplicate replay preserve exactly one execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aura-paper-'));
  const config = fixture(); config.database = join(directory, 'state.sqlite');
  try {
    const first = new PaperRepository(config.database);
    try { const service = new PaperService(config, first); config.events.slice(0, 5).forEach(e => service.process(e)); }
    finally { first.close(); }
    const second = new PaperRepository(config.database);
    try {
      const service = new PaperService(config, second);
      let processed = 0; config.events.forEach(e => { if (service.process(e)) processed++; });
      assert.equal(processed, 7); assert.equal(service.report().cash, '100.23775');
      assert.equal(service.process(config.events[0]), false);
      assert.equal(service.report().revision, 12);
      assert.throws(() => service.process({ ...config.events[0], at: new Date(start + 1).toISOString() }), /different content/);
    } finally { second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('configuration changes cannot silently reuse an account database', () => {
  const config = fixture(), repo = new PaperRepository(':memory:');
  try {
    new PaperService(config, repo);
    assert.throws(() => new PaperService({ ...config, initialCash: '200' }, repo), /different run or configuration/);
  } finally { repo.close(); }
});
test('submission latency prevents fills before activation', () => {
  const config = fixture();
  run(config, service => {
    service.process(config.events[0]);
    service.process({ id: 'early-flow', type: 'sell-flow', at: new Date(start + 50).toISOString(), outcome: 'yes', quantity: '10', limitPrice: '0.44' });
    assert.equal(service.report().fills.length, 0);
    service.process(config.events[1]); assert.equal(service.report().openOrders.length, 2);
  });
});
test('queue volume is consumed before a maker receives a partial fill', () => {
  const config = fixture(); const first = config.events[0]!;
  assert.equal(first.type, 'snapshot'); if (first.type !== 'snapshot') return;
  first.snapshot.books.yes.bids = [{ price: '0.44', quantity: '5' }];
  run(config, service => {
    service.process(first); service.process(config.events[1]); service.process(config.events[2]);
    assert.equal(service.report().fills.length, 0);
    service.process({ id: 'flow-after-queue', type: 'sell-flow', at: new Date(start + 240).toISOString(), outcome: 'yes', quantity: '3', limitPrice: '0.44' });
    assert.equal(service.report().fills[0]?.quantity, '2');
    assert.equal(service.report().positions.yes.quantity, '0');
    assert.equal(service.report().fills[0]?.state, 'provisional');
  });
});
test('cancel releases only the unfilled remainder; committed fill settles after disconnect', () => {
  const config = fixture();
  run(config, service => {
    config.events.slice(0, 3).forEach(e => service.process(e));
    service.process(event(300, 'disconnect', 'disconnect'));
    assert.equal(service.report().openOrders.length, 0); assert.equal(service.report().heldCash, '1.804');
    service.process(event(600, 'settle-after-cancel', 'heartbeat'));
    assert.equal(service.report().cash, '98.196'); assert.equal(service.report().positions.yes.quantity, '4');
    assert.equal(service.report().paused, true);
  });
});
test('settlement failure releases pending holds, credits no shares and pauses execution', () => {
  const config = fixture();
  run(config, service => {
    config.events.slice(0, 3).forEach(e => service.process(e));
    service.process({ id: 'failed', type: 'settlement-failed', at: new Date(start + 400).toISOString(), fillId: 'hybrid-paper-demo:fill:1' });
    service.process(event(600, 'after-failure', 'heartbeat'));
    assert.equal(service.report().cash, '100'); assert.equal(service.report().heldCash, '0');
    assert.equal(service.report().positions.yes.quantity, '0'); assert.equal(service.report().paused, true);
  });
});
test('dead-man timeout cancels orders and a heartbeat cannot silently resume execution', () => {
  const config = fixture();
  run(config, service => {
    service.process(config.events[0]); service.process(config.events[1]);
    service.process(event(2200, 'late-heartbeat', 'heartbeat'));
    assert.equal(service.report().paused, true); assert.equal(service.report().pauseReason, 'dead-man-timeout');
    assert.equal(service.report().openOrders.length, 0);
    service.process(event(2300, 'resume', 'resume')); assert.equal(service.report().paused, false);
  });
});
test('loss limit is enforced and cannot be overridden with resume', () => {
  const config = fixture(); config.maxLoss = '1';
  run(config, service => {
    config.events.slice(0, 3).forEach(e => service.process(e));
    assert.equal(service.report().pauseReason, 'loss-limit');
    assert.throws(() => service.process(event(300, 'resume-loss', 'resume')), /cannot be overridden/);
  });
});
test('independent IOC legs can leave inventory when depth disappears during latency', () => {
  const config = fixture(); config.unwindInventory = false;
  const first = config.events[8]!; if (first.type !== 'snapshot') throw new Error('fixture');
  first.at = new Date(start).toISOString(); first.snapshot.observedAt = first.at; first.snapshot.reward.qualifiedAt = first.at;
  first.snapshot.bookVersion = '1'; first.snapshot.quotes.forEach(q => { q.bookVersion = '1'; });
  const next = structuredClone(first); next.id = 'changed-book'; next.at = new Date(start + 100).toISOString();
  next.snapshot.observedAt = next.at; next.snapshot.reward.qualifiedAt = next.at; next.snapshot.bookVersion = '2';
  next.snapshot.books.no.asks = []; next.snapshot.quotes = [];
  run(config, service => {
    service.process(first); service.process(next); service.process(event(500, 'settle-one-leg', 'heartbeat'));
    assert.equal(service.report().positions.yes.quantity, '10'); assert.equal(service.report().positions.no.quantity, '0');
    assert.equal(service.report().fills.length, 1);
  });
});
test('failed events roll back cached state and cannot advance persisted revision', () => {
  const config = fixture();
  run(config, service => {
    service.process(config.events[0]);
    const before = service.getState();
    assert.throws(() => service.process({ id: 'invalid-failure', type: 'settlement-failed', at: new Date(start + 1).toISOString(), fillId: 'missing' }), /provisional fill/);
    assert.deepEqual(service.getState(), before);
    assert.throws(() => service.process(event(-1, 'old', 'heartbeat')), /chronological/);
  });
});
test('concurrent writers are rejected without mutating their cache', () => {
  const config = fixture(), repo = new PaperRepository(':memory:');
  try {
    const first = new PaperService(config, repo), second = new PaperService(config, repo);
    first.process(config.events[0]);
    assert.throws(() => second.process(config.events[0]), /Concurrent paper writer/);
    assert.equal(second.report().revision, 0);
  } finally { repo.close(); }
});
test('maker remainders below the incentive floor stop earning score-time', () => {
  const config = fixture();
  run(config, service => {
    config.events.slice(0, 4).forEach(e => service.process(e));
    const score = service.report().rewardScoreMs;
    service.process(event(400, 'no-more-rewards', 'heartbeat'));
    assert.equal(service.report().rewardScoreMs, score);
  });
});
