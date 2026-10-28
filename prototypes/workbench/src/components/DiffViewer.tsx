import { useMemo } from 'react';
import { diffRows, type DiffRow } from '../sim/diff';
import { highlight, languageOf } from './format';

type Line = Extract<DiffRow, { text: string }>;
type SplitRow = { kind: 'hunk'; header: string } | { kind: 'pair'; left?: Line; right?: Line };

function toSplit(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: Line[] = [];
  let adds: Line[] = [];
  const flush = (): void => {
    const count = Math.max(dels.length, adds.length);
    for (let i = 0; i < count; i++) out.push({ kind: 'pair', left: dels[i], right: adds[i] });
    dels = []; adds = [];
  };
  for (const row of rows) {
    if (row.type === 'hunk') { flush(); out.push({ kind: 'hunk', header: row.header }); continue; }
    if (row.type === 'del') { dels.push(row); continue; }
    if (row.type === 'add') { adds.push(row); continue; }
    flush();
    out.push({ kind: 'pair', left: row, right: row });
  }
  flush();
  return out;
}

export function DiffViewer({ path, before, after, mode }: { path: string; before: string; after: string; mode: 'unified' | 'split' }) {
  const rows = useMemo(() => diffRows(before, after), [before, after]);
  const language = languageOf(path);
  if (mode === 'split') {
    const split = toSplit(rows);
    return (
      <div className="diff diff-split" role="table" aria-label={`Diff of ${path}`}>
        {split.map((row, index) => row.kind === 'hunk' ? (
          <div key={index} className="diff-hunk">{row.header}</div>
        ) : (
          <div key={index} className="diff-pair">
            <div className={`diff-cell ${row.left ? (row.left.type === 'del' ? 'is-del' : '') : 'is-empty'}`}>
              <span className="ln">{row.left?.oldNo ?? ''}</span>
              <span className="code">{row.left ? highlight(row.left.text, language) : ''}</span>
            </div>
            <div className={`diff-cell ${row.right ? (row.right.type === 'add' ? 'is-add' : '') : 'is-empty'}`}>
              <span className="ln">{row.right?.newNo ?? ''}</span>
              <span className="code">{row.right ? highlight(row.right.text, language) : ''}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="diff diff-unified" role="table" aria-label={`Diff of ${path}`}>
      {rows.map((row, index) => row.type === 'hunk' ? (
        <div key={index} className="diff-hunk">{row.header}</div>
      ) : (
        <div key={index} className={`diff-line is-${row.type}`}>
          <span className="ln">{row.oldNo ?? ''}</span>
          <span className="ln">{row.newNo ?? ''}</span>
          <span className="sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</span>
          <span className="code">{highlight(row.text, language)}</span>
        </div>
      ))}
    </div>
  );
}

export function CodeViewer({ path, content }: { path: string; content: string }) {
  const language = languageOf(path);
  const lines = content.replace(/\n$/, '').split('\n');
  return (
    <div className="code-view" role="table" aria-label={path}>
      {lines.map((line, index) => (
        <div key={index} className="code-line">
          <span className="ln">{index + 1}</span>
          <span className="code">{highlight(line, language)}</span>
        </div>
      ))}
    </div>
  );
}
