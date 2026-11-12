import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageStart, messageStop, sse, textBlock, toolBlock, withProvider } from './support/fake-provider.ts';
import { withAgentHarness } from './support/agent-harness.ts';

// M5.2 through the whole agent: the model searches, then reads only the lines it found. Real Worker runtime, Task Runner
// and Read Adapter children against a local fake of the Messages API.

const WINDOWS = process.platform === 'win32' && process.arch === 'x64';
const filler = (count: number): string => Array.from({ length: count }, (_, index) => `// filler line ${index + 1}`).join('\n');

test('agent: search_text finds the definition and read_file returns just those lines; the timeline never stores the query',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    const files = { 'src/big.ts': `${filler(400)}\nexport function locateMe() { return 42; }\n${filler(400)}\n`, 'src/other.ts': 'export const x = 1;\n' };
    let found: { path: string; line: number } | undefined;
    await withProvider([
      res => sse(res, [messageStart(), ...toolBlock(0, 'toolu_search', 'search_text', { query: 'function locateMe', fileNames: '*.ts' }), ...messageStop('tool_use')]),
      (res, body) => {
        // The second turn sees the search result as path:line: text, and asks for a few lines around it.
        const results = (body.messages.at(-1)!.content as { type: string; content: string }[]).filter(block => block.type === 'tool_result');
        const match = /^(src\/big\.ts):(\d+): /m.exec(results[0]!.content);
        found = match ? { path: match[1]!, line: Number(match[2]) } : undefined;
        sse(res, [messageStart(), ...toolBlock(0, 'toolu_read', 'read_file', { path: 'src/big.ts', startLine: (found?.line ?? 1) - 1, lineCount: 3 }),
          ...messageStop('tool_use')]);
      },
      res => sse(res, [messageStart(), ...textBlock(0, 'locateMe returns 42.'), ...messageStop('end_turn')]),
    ], async (endpoint, bodies) => {
      await withAgentHarness(endpoint, async harness => {
        const task = await harness.runTask('Where is locateMe defined?');
        assert.equal(task.state, 'COMPLETED');
        assert.deepEqual(found, { path: 'src/big.ts', line: 401 });
        const read = (bodies[2]!.messages.at(-1)!.content as { type: string; content: string }[]).find(block => block.type === 'tool_result')!;
        assert.equal(read.content, '[Lines 400-402 of src/big.ts; the file has 801 lines]\n// filler line 400\nexport function locateMe() { return 42; }\n// filler line 1\n');
        // The model was given every tool, and each was described.
        assert.deepEqual((bodies[0]!.tools as { name: string }[]).map(tool => tool.name), ['read_file', 'list_directory', 'search_text', 'find_files']);
        const calls = task.events.flatMap(event => event.type === 'tool_call' ? [event.payload] : []);
        assert.deepEqual(calls.map(call => [call.tool, call.target, call.status, call.size]), [['search_text', '.', 'ok', 1], ['read_file', 'src/big.ts', 'ok', 78]]);
        assert.ok(!JSON.stringify(task.events).includes('locateMe'), 'the query and the file text are not in the event log');
      }, { files });
    });
  });
