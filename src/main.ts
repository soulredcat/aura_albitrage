import { readFile } from 'node:fs/promises';
import { analyzeHybrid } from './bot/hybrid.service.js';
import { AuraClient } from './aura/aura.client.js';
import { PaperRepository } from './storage/paper.repository.js';
import { PaperService } from './paper/paper.service.js';
import { paperConfigSchema } from './paper/paper.validation.js';

try {
  const [command, path, requestFile] = process.argv.slice(2);
  if (command === 'probe') {
    const client = new AuraClient(process.env.AURA_API_BASE_URL ?? 'https://api.aura.markets');
    await client.readProtocolConfig();
    console.log('JSON protocol endpoint reachable; schema and network still require verification.');
  } else if (command === 'paper' && path) {
    const config = paperConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const repository = new PaperRepository(config.database);
    try {
      const service = new PaperService(config, repository);
      let processed = 0;
      for (const event of config.events) if (service.process(event)) processed++;
      console.log(JSON.stringify({ processedEvents: processed, ...service.report() }, null, 2));
    } finally { repository.close(); }
  } else if (command === 'status' && path) {
    const repository = new PaperRepository(path);
    try { console.log(JSON.stringify(repository.load(), null, 2)); } finally { repository.close(); }
  } else if (command === 'quote' && path && requestFile) {
    const expected = process.env.AURA_EXPECTED_NETWORK ?? 'mainnet';
    if (!['mainnet', 'testnet', 'devnet'].includes(expected)) throw new Error('Invalid AURA_EXPECTED_NETWORK');
    const client = new AuraClient(process.env.AURA_API_BASE_URL ?? 'https://api.aura.markets', {
      developerKey: process.env.AURA_DEVELOPER_KEY, sessionBearer: process.env.AURA_SESSION_BEARER });
    const config = await client.verifyNetwork(expected as 'mainnet' | 'testnet' | 'devnet');
    const quote = await client.quote(path, JSON.parse(await readFile(requestFile, 'utf8')));
    console.log(JSON.stringify({ configVersion: config.configVersion, quote, liveOrderSubmitted: false }, null, 2));
  } else if (command === 'analyze' && path) {
    const input: unknown = JSON.parse(await readFile(path, 'utf8'));
    // Fixture clocks are deterministic and do not represent live freshness.
    const fixture = input as { source?: string; observedAt?: string };
    const now = fixture.source === 'fixture' && fixture.observedAt ? Date.parse(fixture.observedAt) : Date.now();
    console.log(JSON.stringify(analyzeHybrid(input, now), null, 2));
  } else throw new Error('Usage: analyze <snapshot.json> | paper <scenario.json> | status <database> | probe | quote <marketAddress> <request.json>');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unknown failure');
  process.exitCode = 1;
}
