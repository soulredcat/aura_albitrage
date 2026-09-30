import { z } from 'zod';

export const baseUnits = z.string().regex(/^(0|[1-9]\d*)$/).max(78);
export const marketAddress = z.string().min(30).max(80).regex(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+(?::[0-3])?$/);
const tick = z.number().int().min(0).max(1000);
export const quoteRequestSchema = z.object({
  outcome: z.enum(['yes', 'no']), side: z.enum(['buy', 'sell']),
  orderType: z.enum(['gtc_limit', 'ioc_market']),
  quantityBaseUnits: baseUnits.optional(), spendBaseUnits: baseUnits.optional(),
  limitPriceTick: tick.optional(), costBoundBaseUnits: baseUnits.optional(),
  feeCapBps: z.number().int().min(0).max(65535).optional(),
  allowPartialFill: z.boolean().optional(), expectedBookVersion: baseUnits.optional()
}).strict().superRefine((request, ctx) => {
  if ((request.quantityBaseUnits === undefined) === (request.spendBaseUnits === undefined))
    ctx.addIssue({ code: 'custom', message: 'Supply exactly one of quantityBaseUnits or spendBaseUnits' });
  if (request.side === 'sell' && request.spendBaseUnits !== undefined)
    ctx.addIssue({ code: 'custom', message: 'spendBaseUnits is BUY-only' });
  if (request.orderType === 'gtc_limit' && request.limitPriceTick === undefined)
    ctx.addIssue({ code: 'custom', message: 'Limit orders require limitPriceTick' });
  if (request.side === 'sell' && request.orderType === 'ioc_market' && request.costBoundBaseUnits === undefined)
    ctx.addIssue({ code: 'custom', message: 'IOC SELL requires a minimum-proceeds costBoundBaseUnits' });
  if (request.quantityBaseUnits === '0' || request.spendBaseUnits === '0')
    ctx.addIssue({ code: 'custom', message: 'Order quantity or spend must be positive' });
});
// Validate fields used by the client. Preserve additional published fields in raw responses.
export const quoteResponseSchema = z.object({
  marketAddress, marketId: z.string().regex(/^[0-9a-f]{64}$/),
  bookVersion: baseUnits, streamCursor: z.string().min(1),
  quotedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), guaranteed: z.literal(false),
  request: z.object({ outcome: z.enum(['yes', 'no']), side: z.enum(['buy', 'sell']),
    orderType: z.enum(['gtc_limit', 'ioc_market']), quantityBaseUnits: baseUnits,
    spendBaseUnits: baseUnits.nullable(), limitPriceTick: tick,
    costBoundBaseUnits: baseUnits, feeCapBps: z.number().int(),
    allowPartialFill: z.boolean(), ownerSelfMatchExcluded: z.boolean() }).passthrough(),
  estimate: z.object({
    fills: z.array(z.object({ quantityBaseUnits: baseUnits, debitBaseUnits: baseUnits,
      creditBaseUnits: baseUnits, feeBaseUnits: baseUnits, executionPriceTick: tick }).passthrough()),
    filledQuantityBaseUnits: baseUnits, unfilledQuantityBaseUnits: baseUnits,
    requiredCollateralBaseUnits: baseUnits, totalFeeBaseUnits: baseUnits,
    expectedProceedsBaseUnits: baseUnits, currentSpendableBaseUnits: baseUnits.nullable()
  }).passthrough(),
  spendable: z.object({ status: z.enum(['available', 'unauthenticated', 'unavailable', 'wallet_account_not_found']) }).passthrough(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() }))
}).passthrough();
export const protocolConfigSchema = z.object({
  configVersion: z.string().min(1),
  network: z.object({ chain: z.literal('alephium'), name: z.enum(['mainnet', 'testnet', 'devnet']), networkId: z.number().int() }).passthrough(),
  collateral: z.object({ tokenId: z.string(), symbol: z.literal('USDT'), decimals: z.number().int().min(0).max(36) }).passthrough(),
  trading: z.object({ quantityLotBaseUnits: baseUnits, pricePrecisionTicks: baseUnits,
    minimumNotionalBaseUnits: baseUnits, quoteLifetimeMs: baseUnits }).passthrough(),
  fees: z.object({ tradeFeeRate: baseUnits, denominator: baseUnits }).passthrough()
}).passthrough();
