import { quoteRequestSchema, quoteResponseSchema, marketAddress, protocolConfigSchema } from './quote.validation.js';
import { receiptKeySchema } from './receipt.service.js';
import { bookSnapshotSchema, consumeRealtime, type RealtimeEvent } from './realtime.service.js';

export class AuraClient {
  constructor(private readonly baseUrl: string, private readonly credentials: { developerKey?: string; sessionBearer?: string } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('API base URL must be HTTPS without credentials, query or fragment');
  }

  async readProtocolConfig(): Promise<unknown> {
    return this.request('/v1/protocol/config');
  }
  async verifyNetwork(expected: 'mainnet' | 'testnet' | 'devnet') {
    const config = protocolConfigSchema.parse(await this.readProtocolConfig());
    if (config.network.name !== expected) throw new Error('Aura network mismatch');
    if (BigInt(config.trading.quantityLotBaseUnits) === 0n || BigInt(config.trading.pricePrecisionTicks) === 0n || BigInt(config.fees.denominator) === 0n)
      throw new Error('Invalid zero protocol divisor or lot size');
    return config;
  }
  async quote(address: string, input: unknown) {
    marketAddress.parse(address);
    const request = quoteRequestSchema.parse(input);
    const quote = quoteResponseSchema.parse(await this.request(`/v1/markets/${encodeURIComponent(address)}/quote`, request));
    if (quote.marketAddress !== address || quote.request.outcome !== request.outcome ||
        quote.request.side !== request.side || quote.request.orderType !== request.orderType)
      throw new Error('Aura quote response does not match the request');
    if (request.expectedBookVersion && quote.bookVersion !== request.expectedBookVersion)
      throw new Error('Aura quote book version mismatch');
    if ((request.quantityBaseUnits !== undefined && quote.request.quantityBaseUnits !== request.quantityBaseUnits) ||
        (request.spendBaseUnits !== undefined && quote.request.spendBaseUnits !== request.spendBaseUnits) ||
        (request.limitPriceTick !== undefined && quote.request.limitPriceTick !== request.limitPriceTick) ||
        (request.costBoundBaseUnits !== undefined && quote.request.costBoundBaseUnits !== request.costBoundBaseUnits) ||
        (request.feeCapBps !== undefined && quote.request.feeCapBps !== request.feeCapBps) ||
        (request.allowPartialFill !== undefined && quote.request.allowPartialFill !== request.allowPartialFill))
      throw new Error('Aura quote terms differ from the request');
    if (quote.estimate.fills.reduce((sum, fill) => sum + BigInt(fill.quantityBaseUnits), 0n).toString() !== quote.estimate.filledQuantityBaseUnits)
      throw new Error('Aura quote fill quantities are inconsistent');
    if (BigInt(quote.estimate.filledQuantityBaseUnits) + BigInt(quote.estimate.unfilledQuantityBaseUnits) !== BigInt(quote.request.quantityBaseUnits))
      throw new Error('Aura quote total quantity is inconsistent');
    return quote;
  }
  async receiptKey(keyId: number) {
    if (!Number.isInteger(keyId) || keyId < 0 || keyId > 4294967295) throw new Error('Invalid receipt key ID');
    const key = receiptKeySchema.parse(await this.request(`/v1/receipt-keys/${keyId}`));
    if (key.keyId !== keyId) throw new Error('Receipt key ID mismatch');
    return key;
  }
  async bookSnapshot(marketId: string) {
    if (!/^[0-9a-f]{64}$/.test(marketId)) throw new Error('marketId must be 64 lowercase hex characters');
    const snapshot = bookSnapshotSchema.parse(await this.request(`/v1/realtime/book/${marketId}/snapshot`));
    if (snapshot.marketId !== marketId) throw new Error('Book snapshot market ID mismatch');
    return snapshot;
  }
  async streamBook(marketId: string, cursor: string, onEvent: (event: RealtimeEvent) => Promise<void>, signal: AbortSignal) {
    if (!/^[0-9a-f]{64}$/.test(marketId)) throw new Error('Invalid market ID');
    const url = new URL('/v1/realtime/stream', this.baseUrl);
    url.searchParams.set('schemaVersion', '2'); url.searchParams.set('topics', `market:${marketId}:book`);
    const headers: Record<string, string> = { accept: 'text/event-stream', 'last-event-id': cursor };
    if (this.credentials.developerKey) headers['x-aura-developer-key'] = this.credentials.developerKey;
    const response = await fetch(url, { headers, signal, redirect: 'manual' });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
      throw new Error(`Aura stream unavailable (HTTP ${response.status})`);
    return consumeRealtime(response.body, cursor, onEvent, signal);
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.credentials.developerKey) headers['x-aura-developer-key'] = this.credentials.developerKey;
    if (this.credentials.sessionBearer) headers.authorization = `Bearer ${this.credentials.sessionBearer}`;
    const response = await fetch(new URL(path, this.baseUrl), {
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(10_000), headers
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error(`Aura API redirected (HTTP ${response.status}); stop integration and verify deployment`);
    if (!response.ok) throw new Error(`Aura API HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('Aura API returned non-JSON; stop integration');
    return response.json();
  }
}
