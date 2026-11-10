import type { ReactNode } from 'react';

// A small, safe Markdown renderer for model answers. Everything becomes React text nodes: no HTML is ever interpreted,
// and links are shown as their text with the URL alongside, never as navigable anchors (model output must not be able to
// drive the app). It covers what answers about code actually use: fenced code, headings, lists, quotes and paragraphs,
// with inline code, bold and italics.

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string };

const MAX_BLOCKS = 2_000;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[index]!;
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const marker = fence[1]!; const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) body.push(lines[index++]!);
      index++;
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { index++; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() }); index++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ kind: 'rule' }); index++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) body.push(lines[index++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const bullet = /^\s*([-*+]|\d{1,9}[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line); const items: string[] = [];
      while (index < lines.length && (bullet.test(lines[index]!) || (/^\s{2,}\S/.test(lines[index]!) && items.length))) {
        const current = lines[index++]!;
        if (bullet.test(current)) items.push(current.replace(bullet, ''));
        else items[items.length - 1] += ' ' + current.trim();
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^\s*(`{3,}|~{3,}|#{1,6}\s|>)/.test(lines[index]!) && !bullet.test(lines[index]!)) body.push(lines[index++]!);
    blocks.push({ kind: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

/** Inline code first (its contents are literal), then bold, italics and links in the remaining text. */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`+)([^`]|[^`][\s\S]*?[^`])\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0; let match: RegExpExecArray | null; let count = 0;
  while ((match = pattern.exec(text)) && count < 5_000) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${count++}`;
    if (match[2] !== undefined) nodes.push(<code key={key} className="md-code">{match[2]}</code>);
    else if (match[3] !== undefined || match[4] !== undefined) nodes.push(<strong key={key}>{match[3] ?? match[4]}</strong>);
    else if (match[5] !== undefined) nodes.push(<em key={key}>{match[5]}</em>);
    else nodes.push(<span key={key} className="md-link" title={match[7]}>{match[6]} <span className="md-url">({match[7]})</span></span>);
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      {parseBlocks(text).map((block, index) => {
        switch (block.kind) {
          case 'code': return <pre key={index} className="md-pre" data-lang={block.lang || undefined}><code>{block.text}</code></pre>;
          case 'heading': {
            const Tag = (`h${Math.min(6, block.level + 2)}`) as 'h3' | 'h4' | 'h5' | 'h6';
            return <Tag key={index} className="md-heading">{renderInline(block.text, `h${index}`)}</Tag>;
          }
          case 'list': {
            const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `l${index}-${itemIndex}`)}</li>);
            return block.ordered ? <ol key={index} className="md-list">{items}</ol> : <ul key={index} className="md-list">{items}</ul>;
          }
          case 'quote': return <blockquote key={index} className="md-quote">{renderInline(block.text, `q${index}`)}</blockquote>;
          case 'rule': return <hr key={index} className="md-rule" />;
          default: return <p key={index} className="md-p">{renderInline(block.text, `p${index}`)}</p>;
        }
      })}
    </div>
  );
}
