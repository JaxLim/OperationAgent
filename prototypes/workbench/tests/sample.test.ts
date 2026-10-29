// Consistency checks for the simulation's sample data: the scripted bug and fix must be
// numerically real, and the diff utilities must round-trip. Runs with Node's type stripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { LEDGER_FILES } from '../src/sim/data/projects.ts';
import { diffRows, diffStats, unifiedPatch } from '../src/sim/diff.ts';

type Totals = { subtotal: number; tax: number; total: number };
type Compute = (invoice: { currency: string; taxRate: number; lines: { unitPrice: number; quantity: number }[] }) => Totals;

/** Evaluates the sample TypeScript in isolation (imports removed, exports inlined). */
function load(...sources: string[]): Compute {
  const js = sources.map(source => stripTypeScriptTypes(source)
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')).join('\n');
  return new Function(`${js}\nreturn computeTotals;`)() as Compute;
}

const INC_4821 = { currency: 'USD', taxRate: 0.08875, lines: [1, 2, 3].map(() => ({ unitPrice: 11.45, quantity: 1 })) };

test('original computeTotals over-charges INC-4821 by one cent', () => {
  const totals = load(LEDGER_FILES['src/invoice/total.ts'].before)(INC_4821);
  assert.equal(totals.tax, 3.06);
  assert.equal(totals.total, 37.41);
});

test('fixed computeTotals rounds tax once per invoice', () => {
  const compute = load(LEDGER_FILES['src/money/minor.ts'].after, LEDGER_FILES['src/invoice/total.ts'].after);
  assert.deepEqual({ ...compute(INC_4821) }, { subtotal: 34.35, tax: 3.05, total: 37.4, currency: 'USD' });
  assert.equal(compute({ currency: 'USD', taxRate: 0, lines: [{ unitPrice: 0.1, quantity: 1 }, { unitPrice: 0.2, quantity: 1 }] }).total, 0.3);
  assert.equal(compute({ currency: 'USD', taxRate: 0.1, lines: [{ unitPrice: 50, quantity: 1 }] }).total, 55);
});

test('the precision regression test passes even on the original code (as the script claims)', () => {
  const compute = load(LEDGER_FILES['src/invoice/total.ts'].before);
  assert.equal(compute({ currency: 'USD', taxRate: 0, lines: [{ unitPrice: 0.1, quantity: 1 }, { unitPrice: 0.2, quantity: 1 }] }).total, 0.3);
});

test('diff stats and rows agree', () => {
  for (const [path, { before, after }] of Object.entries(LEDGER_FILES)) {
    const rows = diffRows(before, after);
    const stats = diffStats(before, after);
    assert.equal(rows.filter(row => row.type === 'add').length, stats.added, path);
    assert.equal(rows.filter(row => row.type === 'del').length, stats.removed, path);
  }
  const patch = unifiedPatch([{ path: 'src/money/minor.ts', kind: 'added', ...LEDGER_FILES['src/money/minor.ts'] }]);
  assert.match(patch, /^diff --git a\/src\/money\/minor\.ts b\/src\/money\/minor\.ts\nnew file mode 100644\n--- \/dev\/null/);
});
