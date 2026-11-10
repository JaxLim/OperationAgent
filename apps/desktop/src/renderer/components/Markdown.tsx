import type { ReactNode } from 'react';
import { parseBlocks, tokenizeInline } from '../markdown';

// A small, safe Markdown renderer for model answers. Everything becomes React text nodes: no HTML is ever interpreted,
// and links are shown as their text with the URL alongside, never as navigable anchors (model output must not be able to
// drive the app). It covers what answers about code actually use: fenced code, headings, lists, quotes and paragraphs,
// with inline code, bold and italics. Parsing lives in ../markdown (pure and linear-time); this file only renders.

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  return tokenizeInline(text).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.kind) {
      case 'code': return <code key={key} className="md-code">{token.text}</code>;
      case 'strong': return <strong key={key}>{token.text}</strong>;
      case 'em': return <em key={key}>{token.text}</em>;
      case 'link': return <span key={key} className="md-link" title={token.url}>{token.text} <span className="md-url">({token.url})</span></span>;
      default: return token.text;
    }
  });
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
