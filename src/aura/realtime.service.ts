import { z } from 'zod';

const exact = z.string().regex(/^(0|[1-9]\d*)$/);
export const bookSnapshotSchema = z.object({ marketId: z.string().regex(/^[0-9a-f]{64}$/),
  bookVersion: exact, streamCursor: z.string().min(1), asOf: z.iso.datetime(),
  tradingStatus: z.enum(['open', 'paused', 'closed']),
  bids: z.array(z.object({ priceTick: exact, quantity: exact })),
  asks: z.array(z.object({ priceTick: exact, quantity: exact })) }).passthrough();
export const realtimeEventSchema = z.object({ schemaVersion: z.literal(2), id: z.string().min(1),
  type: z.string().min(1), occurredAt: z.iso.datetime(), cursor: z.string().min(1),
  source: z.object({ name: z.enum(['main', 'sequencer', 'wallet']), generation: z.string().min(1),
    sequence: exact, ordinal: z.number().int().nonnegative(), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  data: z.record(z.string(), z.unknown()) }).passthrough();
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type SseFrame = { event: string; id: string; data: string };

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', frame: SseFrame = { event: 'message', id: '', data: '' }, size = 0;
  function consume(line: string): SseFrame | null {
    if (line === '') {
      const emitted = frame.data ? { ...frame, data: frame.data.slice(0, -1) } : null;
      frame = { event: 'message', id: '', data: '' }; size = 0; return emitted;
    }
    size += line.length;
    if (size > 1_048_576) throw new Error('Oversized SSE frame');
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') frame.data += `${value}\n`;
    else if (field === 'event') frame.event = value;
    else if (field === 'id' && !value.includes('\0')) frame.id = value;
    return null;
  }
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\n|\r/.exec(buffer))) {
        if (!chunk.done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const emitted = consume(line); if (emitted) yield emitted;
      }
      if (buffer.length > 1_048_576) throw new Error('Oversized SSE line');
      if (chunk.done) break;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export class RealtimeReset extends Error {}
export class RealtimeUnavailable extends Error {
  constructor(public readonly code: string, public readonly recoverable: boolean) { super(`Aura stream error: ${code}`); }
}
export async function consumeRealtime(body: ReadableStream<Uint8Array>, cursor: string,
  onEvent: (event: RealtimeEvent) => Promise<void>, signal?: AbortSignal) {
  const seen = new Map<string, string>();
  let lastCursor = cursor;
  for await (const frame of readSse(body, signal)) {
    if (frame.event === 'aura-reset') throw new RealtimeReset('Aura requested a fresh snapshot');
    const json: unknown = JSON.parse(frame.data);
    if (frame.event === 'aura-error') {
      const error = z.object({ code: z.string(), recoverable: z.boolean() }).passthrough().parse(json);
      throw new RealtimeUnavailable(error.code, error.recoverable);
    }
    const event = realtimeEventSchema.parse(json);
    if (!frame.id || frame.id !== event.cursor) throw new Error('SSE cursor and event cursor differ');
    const signature = JSON.stringify(event);
    const prior = seen.get(event.id);
    if (prior && prior !== signature) throw new Error('Conflicting duplicate realtime event');
    if (!prior) {
      await onEvent(event); seen.set(event.id, signature);
    }
    lastCursor = frame.id;
  }
  return lastCursor;
}
