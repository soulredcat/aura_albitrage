# Aura hybrid bot — analysis and paper execution

A TypeScript implementation for binary YES/NO arbitrage analysis, liquidity-reward market-making plans, and persistent paper execution. It includes a synthetic replay runtime, an order/fill/account ledger, inventory unwinding, risk controls, and public API clients for canonical quotes, book snapshots, receipt verification keys, and schema-v2 SSE consumption. **Live order submission and private-account reconciliation are not implemented.** Fixtures represent synthetic scenarios, not real market opportunities or historical replays. Node.js 22.13 or later is required; the tested runtime is Node.js 22.22.1. Its built-in SQLite module emits an experimental-feature warning.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run demo
npm.cmd run paper
npm.cmd run status
npm.cmd run probe
```

To analyze another internal snapshot, run `npx.cmd tsx src/main.ts analyze <file.json>`. The schema is defined in `src/domain/snapshot.validation.ts`. This is an internal adapter contract, not Aura's API response format. All amounts and prices are decimal strings. A future live adapter must convert native base units using verified protocol configuration. Fixtures use a fixed clock; snapshots marked `verified-adapter` are checked against the current time. That source label does not itself verify the supplied data.

## Implemented strategies

- **Arbitrage:** compares the pair payout against two fee-inclusive BUY quotes and additional costs. Rejects expired quotes, warnings, inconsistent book versions, partial fills, unequal quantities, unverified payouts, insufficient budgets, and violations of order-size, lot-size, or single-leg inventory limits. Profit remains conditional on both legs filling and settling. The analyzer does not assume atomic multi-order execution or immediate redemption.
- **Market making:** plans BUY YES and BUY NO orders as complementary economic sides. Prices are rounded to ticks and capped below direct asks and complementary bid prices to avoid crossing the supplied book. Quantities are rounded to lots, must meet the incentive floor, and are limited by single-sided fill exposure. The budget covers both orders and a configurable fee reserve. This is a snapshot-based plan, not a post-only execution guarantee.
- **Rewards:** computes the position score using `((v-s)/v)^2 * b` within the eligible range, with two-sided scoring and extreme-midpoint rules. Reward payouts are not projected without epoch samples, competing maker scores, and the actual reward pool. The qualified midpoint must be supplied separately from the execution book.
- **Hybrid allocation:** selects one strategy per snapshot to prevent double allocation of the same budget. Arbitrage candidates take priority; the maker plan remains visible for inspection.

The example fixture produces a conditional pair profit of `0.15` collateral units for 10 pairs. All fixture values are synthetic. Its fee-inclusive quotes are not responses from Aura's quote endpoint, and its incentive, spread, lot, and tick parameters are not verified Aura configuration.

## Paper runtime

`npm run paper` replays `fixtures/paper.json` and persists its account state in `data/hybrid-paper.sqlite`. A run is bound to one market, one run ID, and immutable risk/execution settings. Re-running the same scenario skips committed events; restarting midway recovers orders, pending settlements, positions, and event identities from SQLite. Use a new database and run ID for an independent experiment. Settings or engine-version changes require a separate database.

The supplied scenario covers complementary maker quotes, delayed activation, partial fills, settlement, an inventory unwind, an arbitrage pair, and explicit binary resolution. Its final cash is `100.23775` from initial cash of `100`, with realized P&L of `0.23775`. This is a deterministic synthetic example, not measured performance or a forecast. Additional pair costs used in candidate screening are conservative allowances; they are not debited as actual costs in the synthetic fill ledger. Paper fill fees use the scenario's fee fraction.

Supported events are `snapshot`, `sell-flow`, `heartbeat`, `settlement-failed`, `disconnect`, `resume`, `shutdown`, and `resolution`. Events must be chronological. A `sell-flow` describes simulated aggressive sell quantity with a minimum execution price; it is not an Aura trade event. Existing better or equal bids initialize an approximate queue ahead of maker orders. Paper taker orders consume direct-book depth and cancel unmatched IOC remainders. Complement mint/burn matching, chain reorgs after settlement, and real queue reconstruction are not simulated.

Cash and share holds remain separate from settled balances. Cancellation releases only unfilled order reservations; provisional fills retain their obligations until settlement or simulated failure. Cash, inventory, event identity, and an audit journal commit in one SQLite transaction. Business logic operates on cached state; raw database operations are contained in `src/storage/paper.repository.ts`. Optimistic revisions reject competing writers.

The replay applies dead-man timeouts, stale-data pauses, order expiry, inventory limits, and a conservative loss limit. The dead-man switch here is simulated in replay time; it does not cancel orders on Aura. Heartbeat events do not automatically clear a pause. Loss-limit pauses cannot be overridden with `resume` in the same run. Liquidation equity values settled positions against available direct bid depth, with unmatched depth valued at zero; pending BUY obligations are deducted without crediting pending assets. This intentionally conservative value can pause execution before actual realized losses reach the threshold.

`rewardScoreMs` is score multiplied by eligible resting time, without normalization against competing makers. Remainders below the incentive floor stop earning. This metric is not Aura's sampled epoch calculation and is not an expected reward payout.

## Public API clients and wallet credentials

The validated quote client uses the published `POST /v1/markets/{address}/quote` request schema. It checks echoed terms, book version, exact quantity consistency, and the response's `guaranteed: false` field. Run it once a valid API deployment is available:

```powershell
$env:AURA_API_BASE_URL = 'https://api.aura.markets'
$env:AURA_EXPECTED_NETWORK = 'mainnet'
npx.cmd tsx src/main.ts quote <marketAddress> fixtures/quote-request.json
```

The example quantity is synthetic. Verify collateral decimals, lot size, and limits from protocol configuration before choosing a real request amount. The CLI verifies the configured network before quoting. It prints warnings and expiry metadata for inspection; a quote is never a fill reservation. The CLI reads process environment variables and does not automatically load `.env`.

`AuraClient.bookSnapshot()` validates the published display-book snapshot. `AuraClient.streamBook()` reads a public schema-v2 stream from a supplied snapshot cursor and calls an async consumer before advancing the cursor. The SSE reader handles chunked UTF-8/CRLF, duplicate semantic event IDs within a connection, malformed envelopes, cursor mismatches, and bounded frame sizes. Resets and stream errors propagate explicitly. The caller must implement reconnect backoff, resnapshot recovery, cross-connection durable deduplication, and mapping of event payloads to trading state. These methods are not yet connected to an unattended live bot.

The record `{ keyId, algorithm: 'Ed25519', publicKeySpkiHex }` comes from `GET /v1/receipt-keys/{keyId}`. It is Aura's public receipt verification key, not a wallet private key or developer API credential. `publicKeySpkiHex` must contain 88 lowercase hex characters; `<string>` is a placeholder. The receipt helper verifies exact receipt bytes against an independently trusted public key. It does not decode receipt semantics, prove settlement, or establish the key's trust by itself.

The documented live order flow requires a scoped developer key plus a user-created restricted trading authorization bound to the developer key's builder identity. An Alephium wallet private key alone does not authorize that API flow. Neither the paper runtime nor the public quote client requires a wallet private key. Keep credentials in local environment variables or a secret manager, never in fixtures or version control.

## Integration findings — September 30, 2026

These observations were made from the development environment and do not establish availability from every network or client.

1. `https://api.aura.markets/v1/protocol/config` returned HTTP 302 to `http://docs.aura.markets`. Following the redirect from `/openapi.json` also produced a documentation page.
2. The testnet configuration endpoint failed TLS certificate validation with `ERR_TLS_CERT_ALTNAME_INVALID`. TLS verification remains enabled.
3. `npm view @aura/builder-sdk version` returned E404 from the public npm registry.
4. `https://docs.aura.markets/mcp` accepted MCP initialization and `tools/list` over POST/SSE. GET returned 405. Available tools were `search_aura`, `query_docs_filesystem_aura`, and `submit_feedback`. This is a documentation MCP server. The listed tools do not provide live market data or trading operations. Its virtual documentation filesystem exposes OpenAPI at `/openapi/api-reference/openapi.json`; the specification's server list contains only the relative URL `/`, which does not identify an alternative API deployment.

`npm run probe` checks whether the protocol configuration endpoint returns JSON and reports explicit errors for redirects, HTML responses, or TLS failures. A successful probe does not verify the schema, network, or trading readiness. Set `AURA_API_BASE_URL` to the correct HTTPS deployment when one becomes available. This stage requires no credentials.

## Remaining work before live execution

1. Verify the API deployment, network, contracts, and published schema; retain `configVersion`. Identify the authoritative qualified midpoint and current incentive parameters.
2. Connect validated public snapshots and streams to strategy state with durable cursor/deduplication storage, reconnect backoff, reset/resnapshot handling, and verified mappings of dual-book and qualified pricing data. The paper ledger is not a substitute for live account authority.
3. Integrate private account snapshots and lifecycle events, including settlement unwinds and reorg corrections. Use the account API's authoritative spendable balance, which accounts for holds and pending obligations; do not derive it by adding raw balances together.
4. Calibrate the synthetic paper model against actual venue data, including complement matching, queue uncertainty, and observed settlement behavior. Local scenarios alone do not establish live profitability.
5. Implement durable live order submission and reconciliation with the developer key and restricted trading authorization bound to `builderCode`, stable idempotency, cancellation result handling, and the real Aura dead-man switch. Verify authorization caps and receipt semantics before enabling execution.

## Verification

TypeScript validation and all 33 tests passed. Tests cover analysis economics and risk limits, persistent restart recovery, duplicate-event conflicts, concurrent writers, cash/share reservations, submission latency, queue consumption, partial fills, cancellation races, failed settlement, dead-man and loss-limit behavior, one-leg IOC exposure, resolution/P&L, receipt signatures, quote validation, and SSE framing/reset/error handling. These checks validate local behavior and mocked protocol handling; they do not establish live integration correctness.

## Official references

- [Liquidity rewards](https://docs.aura.markets/programs/liquidity-rewards)
- [API overview](https://docs.aura.markets/api-reference/introduction)
- [Builder integration guide](https://docs.aura.markets/api-reference/integrator-guide)
- [Prepare API order](https://docs.aura.markets/api-reference/place-your-first-order)
- [Realtime data](https://docs.aura.markets/api-reference/realtime)
- [Documentation MCP endpoint](https://docs.aura.markets/mcp)
