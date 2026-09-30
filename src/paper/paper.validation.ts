import { z } from 'zod';
import { snapshotSchema } from '../domain/snapshot.validation.js';

const amount = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).max(60);
const positive = amount.refine(v => /[1-9]/.test(v));
const base = { id: z.string().min(1), at: z.iso.datetime() };
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('snapshot'), snapshot: snapshotSchema }),
  z.object({ ...base, type: z.literal('sell-flow'), outcome: z.enum(['yes', 'no']),
    limitPrice: positive, quantity: positive }),
  z.object({ ...base, type: z.literal('settlement-failed'), fillId: z.string().min(1) }),
  z.object({ ...base, type: z.literal('heartbeat') }),
  z.object({ ...base, type: z.literal('disconnect') }),
  z.object({ ...base, type: z.literal('resume') }),
  z.object({ ...base, type: z.literal('resolution'), winner: z.enum(['yes', 'no']) }),
  z.object({ ...base, type: z.literal('shutdown') })
]);
export const paperConfigSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1),
  database: z.string().min(1), initialCash: positive,
  feeFraction: amount.refine(v => Number(v) <= 1),
  submitLatencyMs: z.number().int().nonnegative(),
  settlementLatencyMs: z.number().int().positive(),
  deadManTimeoutMs: z.number().int().positive(),
  orderLifetimeMs: z.number().int().positive(),
  maxLoss: positive, unwindInventory: z.boolean(),
  events: z.array(eventSchema).min(1)
}).superRefine((c, ctx) => {
  if (c.submitLatencyMs >= c.orderLifetimeMs || c.deadManTimeoutMs >= c.orderLifetimeMs)
    ctx.addIssue({ code: 'custom', message: 'order lifetime must exceed submission latency and dead-man timeout' });
});
export type PaperEvent = z.infer<typeof eventSchema>;
export type PaperConfig = z.infer<typeof paperConfigSchema>;
