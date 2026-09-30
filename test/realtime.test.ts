import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSse, consumeRealtime, RealtimeReset, RealtimeUnavailable } from '../src/aura/realtime.service.js';

function stream(parts: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({ start(controller) { parts.forEach(p => controller.enqueue(encoder.encode(p))); controller.close(); } });
}
function event(id = 'event-1', cursor = 'rt2.cursor') {
  return { schemaVersion: 2, id, cursor, type: 'order.accepted', occurredAt: '2026-09-30T14:00:00.000Z',
    source: { name: 'sequencer', generation: 'g1', sequence: '9007199254740993', ordinal: 0, hash: 'a'.repeat(64) },
    data: { quantityBaseUnits: '1000000000000000000' } };
}
const frame = (data: unknown, cursor = 'rt2.cursor') => `id: ${cursor}\nevent: message\ndata: ${JSON.stringify(data)}\n\n`;

test('SSE parses chunked CRLF, comments and multiline data', async () => {
  const frames = [];
  for await (const item of readSse(stream([': heartbeat\r', '\nid: rt2.test\r\nevent: message\r\ndata: first\r\n', 'data: second\r\n\r\n']))) frames.push(item);
  assert.deepEqual(frames, [{ event: 'message', id: 'rt2.test', data: 'first\nsecond' }]);
});
test('duplicate semantic IDs are processed once and conflicting payloads fail', async () => {
  let count = 0;
  assert.equal(await consumeRealtime(stream([frame(event()), frame(event())]), 'rt2.start', async () => { count++; }), 'rt2.cursor');
  assert.equal(count, 1);
  await assert.rejects(consumeRealtime(stream([frame(event()), frame({ ...event(), type: 'order.cancelled' })]), 'rt2.start', async () => {}), /Conflicting duplicate/);
});
test('reset and stream errors require explicit recovery rather than silently advancing', async () => {
  await assert.rejects(consumeRealtime(stream(['event: aura-reset\ndata: {}\n\n']), 'rt2.start', async () => {}), RealtimeReset);
  await assert.rejects(consumeRealtime(stream(['event: aura-error\ndata: {"code":"source_unavailable","recoverable":true}\n\n']), 'rt2.start', async () => {}), RealtimeUnavailable);
});
test('consumer persistence failure propagates and cursor mismatch fails', async () => {
  await assert.rejects(consumeRealtime(stream([frame(event())]), 'rt2.start', async () => { throw new Error('disk failure'); }), /disk failure/);
  await assert.rejects(consumeRealtime(stream([frame(event(), 'rt2.wrong')]), 'rt2.start', async () => {}), /cursor differ/);
});
test('incompatible schemas, oversized frames and incomplete frames are rejected or discarded', async () => {
  await assert.rejects(consumeRealtime(stream([frame({ ...event(), schemaVersion: 1 })]), 'rt2.start', async () => {}));
  await assert.rejects(async () => { for await (const _frame of readSse(stream(['data: ' + 'x'.repeat(1_048_577)]))) { /* consume */ } }, /Oversized/);
  const frames = []; for await (const item of readSse(stream(['data: incomplete\n']))) frames.push(item);
  assert.equal(frames.length, 0);
});
