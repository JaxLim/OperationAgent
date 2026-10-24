// Re-evaluate retained raw records; never substitutes for executing the probes.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CaseRecord, evaluate } from './evaluate.js';
import { Mode } from './contracts.js';

const lab = fileURLToPath(new URL('../../', import.meta.url));
const path = resolve(process.argv[2] ?? '');
const within = relative(resolve(lab, 'evidence'), path);
if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Expected one experiment evidence subdirectory');
const metadata = z.object({ sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).parse(JSON.parse(await readFile(resolve(path, 'environment.json'), 'utf8')) as unknown);
const hashesMatch = (await Promise.all(Object.entries(metadata.sourceHashes).map(async ([name, hash]) => {
  const source = resolve(lab, name); const child = relative(lab, source);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error('Source escapes experiment');
  return createHash('sha256').update(await readFile(source)).digest('hex') === hash;
}))).every(Boolean);
const records = [];
for (const name of await readdir(path)) {
  if (!name.endsWith('.json') || !Mode.options.some(mode => name.startsWith(`${mode}-`))) continue;
  const record = CaseRecord.parse(JSON.parse(await readFile(resolve(path, name), 'utf8')) as unknown);
  records.push({ name, matrix: evaluate(record), workerAliveAfter: record.workerAliveAfter, expressAliveAfter: record.expressAliveAfter });
}
const required = ['stockForkApi', 'directExpressParent', 'osRestrictedBeforeFirstInstruction', 'legalNodeIpcRpc', 'protectedFileReadWrite', 'externalTcpDenied', 'loopbackTcpDenied', 'nativeChildCreationDenied', 'installedApplication', 'startupRaceStress', 'restartBudget'];
const allRequirementsProven = records.some(record => required.every(key => record.matrix[key] === 'PASS'));
const evidenceValid = hashesMatch && records.length === 12 && records.every(r => !r.workerAliveAfter && !r.expressAliveAfter);
const expectedExitCode = !evidenceValid ? 1 : process.argv.includes('--require-dec001') && !allRequirementsProven ? 2 : 0;
const result = { evidenceValid, hashesMatch, cases: records.length, allRequirementsProven, dec001Closed: false, productionSandbox: false, command: [process.execPath, ...process.argv.slice(1)], expectedExitCode, records };
await writeFile(resolve(path, 'acceptance-replay.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ evidenceValid, cases: records.length, allRequirementsProven, exitCode: expectedExitCode, report: resolve(path, 'acceptance-replay.json') }));
process.exitCode = expectedExitCode;
