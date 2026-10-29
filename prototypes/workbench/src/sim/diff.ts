export type DiffRow =
  | { type: 'hunk'; header: string }
  | { type: 'ctx' | 'add' | 'del'; oldNo?: number; newNo?: number; text: string };

interface Op { type: 'ctx' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level LCS diff. Inputs are small sample files, so O(n·m) is fine. */
function diffOps(before: string, after: string): Op[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'ctx', text: a[i]!, oldNo: i + 1, newNo: j + 1 }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ type: 'del', text: a[i]!, oldNo: i + 1 }); i++; }
    else { ops.push({ type: 'add', text: b[j]!, newNo: j + 1 }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', text: a[i]!, oldNo: i + 1 }); i++; }
  while (j < m) { ops.push({ type: 'add', text: b[j]!, newNo: j + 1 }); j++; }
  return ops;
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffOps(before, after)) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}

/** Unified diff rows grouped into hunks with `context` lines around each change. */
export function diffRows(before: string, after: string, context = 3): DiffRow[] {
  const ops = diffOps(before, after);
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type === 'ctx') return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < ops.length) {
    if (!keep[index]) { index++; continue; }
    const start = index;
    while (index < ops.length && keep[index]) index++;
    const chunk = ops.slice(start, index);
    const oldStart = chunk.find(op => op.oldNo !== undefined)?.oldNo ?? 0;
    const newStart = chunk.find(op => op.newNo !== undefined)?.newNo ?? 0;
    const oldCount = chunk.filter(op => op.type !== 'add').length;
    const newCount = chunk.filter(op => op.type !== 'del').length;
    rows.push({ type: 'hunk', header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` });
    for (const op of chunk) rows.push({ type: op.type, text: op.text, oldNo: op.oldNo, newNo: op.newNo });
  }
  return rows;
}

/** Plain-text unified patch used for the downloadable/inspectable patch artifact. */
export function unifiedPatch(files: { path: string; before: string; after: string; kind: 'modified' | 'added' }[]): string {
  const out: string[] = [];
  for (const file of files) {
    out.push(`diff --git a/${file.path} b/${file.path}`);
    if (file.kind === 'added') out.push('new file mode 100644');
    out.push(file.kind === 'added' ? '--- /dev/null' : `--- a/${file.path}`);
    out.push(`+++ b/${file.path}`);
    for (const row of diffRows(file.before, file.after)) {
      if (row.type === 'hunk') out.push(row.header);
      else out.push(`${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}${row.text}`);
    }
  }
  return out.join('\n') + '\n';
}

/** FNV-1a, displayed as a short grant fingerprint. Not a security primitive: the demo grants nothing real. */
export function fingerprint(parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const char of parts.join('\u0000')) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const second = Math.imul(hash ^ 0x5bd1e995, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}
