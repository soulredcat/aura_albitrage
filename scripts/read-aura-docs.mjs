// Read-only MCP documentation access. Never invokes feedback or trading tools.
const endpoint = 'https://docs.aura.markets/mcp';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let nextId = 1;
async function rpc(method, params, notification = false) {
  const body = { jsonrpc: '2.0', method, params, ...(!notification ? { id: nextId++ } : {}) };
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Documentation MCP HTTP ${response.status}`);
  const session = response.headers.get('mcp-session-id');
  if (session) headers['mcp-session-id'] = session;
  const text = await response.text();
  if (notification) return;
  const messages = response.headers.get('content-type')?.includes('application/json')
    ? [JSON.parse(text)] : text.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice(5).trim()));
  const reply = messages.find(message => message.id === body.id);
  if (!reply || reply.error) throw new Error(JSON.stringify(reply?.error ?? 'Missing MCP response'));
  return reply.result;
}
try {
  const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'aura-docs-reader', version: '0.1.0' } });
  headers['mcp-protocol-version'] = initialized.protocolVersion;
  await rpc('notifications/initialized', {}, true);
  const command = process.argv[2] ?? 'tree / -L 2';
  const result = await rpc('tools/call', { name: 'query_docs_filesystem_aura', arguments: { command } });
  if (result.isError) throw new Error('Documentation query failed');
  for (const item of result.content ?? []) if (item.type === 'text') console.log(item.text);
} catch (error) { console.error(error.message); process.exitCode = 1; }
