import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';

// A local fake of the Messages API streaming endpoint: real HTTP and real SSE framing, so the real SDK parser runs.

export type ProviderBody = { messages: { role: string; content: unknown }[]; [key: string]: unknown };
export type ProviderScript = (res: ServerResponse, body: ProviderBody) => void;

export function sse(res: ServerResponse, events: Record<string, unknown>[], end = true): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  if (end) res.end();
}
export const messageStart = (model = 'claude-sonnet-5-5'): Record<string, unknown> => ({ type: 'message_start', message: { id: 'msg_fake', type: 'message',
  role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } });
export const messageStop = (reason: string): Record<string, unknown>[] => [
  { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 7 } }, { type: 'message_stop' }];
export const textBlock = (index: number, value: string): Record<string, unknown>[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } }, { type: 'content_block_stop', index }];
export const toolBlock = (index: number, id: string, name: string, input: unknown): Record<string, unknown>[] => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, { type: 'content_block_stop', index }];

/** Serves scripts in order (the last one repeats) and records every request body with its headers. */
export async function withProvider(scripts: ProviderScript[],
  run: (endpoint: string, bodies: ProviderBody[], headers: IncomingHttpHeaders[]) => Promise<void>): Promise<void> {
  const bodies: ProviderBody[] = []; const headers: IncomingHttpHeaders[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderBody;
      bodies.push(body); headers.push(req.headers);
      scripts[Math.min(bodies.length - 1, scripts.length - 1)]!(res, body);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try { await run(`http://127.0.0.1:${address.port}`, bodies, headers); } finally { server.closeAllConnections(); server.close(); }
}
