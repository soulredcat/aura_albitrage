import { z } from 'zod';

const unsigned = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).max(80);
const positive = unsigned.refine(v => /[1-9]/.test(v), 'must be positive');
const outcome = z.enum(['yes', 'no']);
const level = z.object({ price: positive, quantity: positive });
const book = z.object({ bids: z.array(level), asks: z.array(level) });
const quote = z.object({
  outcome, side: z.literal('buy'), quantity: positive, filledQuantity: positive,
  totalCostIncludingFees: positive, bookVersion: z.string().min(1),
  expiresAt: z.iso.datetime(), warnings: z.array(z.string())
});

// This is our internal fixture/adapter contract, NOT Aura's wire schema.
export const snapshotSchema = z.object({
  source: z.enum(['fixture', 'verified-adapter']),
  observedAt: z.iso.datetime(), marketId: z.string().min(1),
  bookVersion: z.string().min(1), tradingStatus: z.enum(['open', 'closed']),
  binaryPayoutVerified: z.boolean(), payoutPerPair: positive,
  books: z.object({ yes: book, no: book }),
  reward: z.object({
    adjustedYesMidpoint: positive, maxDistance: positive,
    minIncentiveQuantity: positive, multiplier: positive,
    qualifiedAt: z.iso.datetime()
  }),
  quotes: z.array(quote),
  risk: z.object({
    cashAvailable: unsigned, cashReserve: unsigned,
    yesInventory: unsigned, noInventory: unsigned,
    maxDirectionalShares: positive, maxOrderQuantity: positive,
    maxTotalSpend: positive, feeReserveFraction: unsigned,
    extraPairCost: unsigned, minPairProfit: positive,
    halfSpread: positive, tickSize: positive,
    lotSize: positive, maxAgeMs: z.number().int().positive()
  })
});
export type Snapshot = z.infer<typeof snapshotSchema>;
