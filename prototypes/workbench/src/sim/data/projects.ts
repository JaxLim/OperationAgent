import type { Project } from '../types';

// Fictional sample projects. Paths are display-only labels; no folder is opened or read.

const TOTAL_TS = `import type { Invoice, InvoiceTotals } from './types';

/**
 * Computes subtotal, tax and grand total for an invoice.
 * Amounts are decimal currency units (e.g. 12.5 = $12.50).
 */
export function computeTotals(invoice: Invoice): InvoiceTotals {
  let subtotal = 0;
  let tax = 0;

  for (const line of invoice.lines) {
    const lineAmount = line.unitPrice * line.quantity;
    subtotal += lineAmount;
    // Tax is rounded per line to two decimals.
    tax += Number((lineAmount * invoice.taxRate).toFixed(2));
  }

  const total = subtotal + tax;
  return {
    subtotal: Number(subtotal.toFixed(2)),
    tax: Number(tax.toFixed(2)),
    total: Number(total.toFixed(2)),
    currency: invoice.currency,
  };
}
`;

const TOTAL_TS_FIXED = `import type { Invoice, InvoiceTotals } from './types';
import { fromMinor, roundHalfEven, toMinor } from '../money/minor';

/**
 * Computes subtotal, tax and grand total for an invoice.
 * Arithmetic runs in integer minor units; tax is rounded once per
 * invoice with half-even rounding, as required by FIN-212.
 */
export function computeTotals(invoice: Invoice): InvoiceTotals {
  let subtotalMinor = 0;

  for (const line of invoice.lines) {
    subtotalMinor += toMinor(line.unitPrice) * line.quantity;
  }

  const taxMinor = roundHalfEven(subtotalMinor * invoice.taxRate);
  const totalMinor = subtotalMinor + taxMinor;

  return {
    subtotal: fromMinor(subtotalMinor),
    tax: fromMinor(taxMinor),
    total: fromMinor(totalMinor),
    currency: invoice.currency,
  };
}
`;

const MINOR_TS = `/**
 * Money helpers that keep arithmetic in integer minor units (cents)
 * to avoid binary floating-point drift.
 */
export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

export function fromMinor(minor: number): number {
  return minor / 100;
}

/** Rounds a fractional minor amount half to even (banker's rounding). */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (Math.abs(fraction - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}
`;

const TEST_TS = `import { describe, expect, it } from 'vitest';
import { computeTotals } from '../../src/invoice/total';
import { invoice } from '../fixtures/invoice';

describe('computeTotals', () => {
  it('returns zero totals for an empty invoice', () => {
    expect(computeTotals(invoice({ lines: [] })).total).toBe(0);
  });

  it('sums a single line', () => {
    const totals = computeTotals(invoice({ lines: [{ unitPrice: 19.99, quantity: 1 }] }));
    expect(totals.subtotal).toBe(19.99);
  });

  it('applies the tax rate', () => {
    const totals = computeTotals(invoice({ taxRate: 0.1, lines: [{ unitPrice: 50, quantity: 1 }] }));
    expect(totals.tax).toBe(5);
    expect(totals.total).toBe(55);
  });

  it('multiplies by quantity', () => {
    const totals = computeTotals(invoice({ lines: [{ unitPrice: 2.5, quantity: 4 }] }));
    expect(totals.subtotal).toBe(10);
  });

  it('preserves the invoice currency', () => {
    expect(computeTotals(invoice({ currency: 'EUR' })).currency).toBe('EUR');
  });

  it('handles a zero tax rate', () => {
    const totals = computeTotals(invoice({ taxRate: 0, lines: [{ unitPrice: 8, quantity: 3 }] }));
    expect(totals.tax).toBe(0);
  });
});
`;

const TEST_TS_FIXED = TEST_TS.replace(/\n\}\);\n$/, `

  it('rounds tax once per invoice (INC-4821)', () => {
    const line = { unitPrice: 11.45, quantity: 1 };
    const totals = computeTotals(invoice({ taxRate: 0.08875, lines: [line, line, line] }));
    expect(totals.subtotal).toBe(34.35);
    expect(totals.tax).toBe(3.05);
    expect(totals.total).toBe(37.4);
  });

  it('keeps minor-unit precision for fractional prices', () => {
    const totals = computeTotals(invoice({ taxRate: 0, lines: [
      { unitPrice: 0.1, quantity: 1 },
      { unitPrice: 0.2, quantity: 1 },
    ] }));
    expect(totals.total).toBe(0.3);
  });
});
`);

const CHANGELOG = `# Changelog

## Unreleased

## 2.14.0 — 2026-10-09

- Invoices: expose \`currency\` on the totals payload.
- Routes: return 422 for invoices without lines.

## 2.13.2 — 2026-09-22

- Fix: trailing whitespace in PDF reference numbers.
`;

const CHANGELOG_FIXED = CHANGELOG.replace('## Unreleased\n', `## Unreleased

- Fix: invoice tax is rounded once per invoice using half-even rounding (FIN-212).
  Multi-line invoices could previously be over-charged by one cent (INC-4821).
`);

export const LEDGER_FILES = {
  'src/invoice/total.ts': { before: TOTAL_TS, after: TOTAL_TS_FIXED },
  'src/money/minor.ts': { before: '', after: MINOR_TS },
  'tests/invoice/total.test.ts': { before: TEST_TS, after: TEST_TS_FIXED },
  'CHANGELOG.md': { before: CHANGELOG, after: CHANGELOG_FIXED },
} as const;

export const PROJECTS: Project[] = [
  {
    id: 'ledger-api',
    name: 'ledger-api',
    path: '~/sample-projects/ledger-api',
    branch: 'main',
    description: 'Billing service — invoices, payments and tax rules',
    language: 'TypeScript',
    accent: '#5b7cfa',
    files: [
      { path: 'README.md', content: `# ledger-api

Billing service for invoices, payments and tax rules.

## Money rules

- Store and compute amounts in **minor units** where possible.
- Tax is rounded **once per invoice** using banker's rounding (FIN-212).
- Never round per line item.

## Scripts

\`\`\`sh
pnpm test          # vitest
pnpm dev           # local server on :4010
\`\`\`
` },
      { path: 'package.json', content: `{
  "name": "ledger-api",
  "version": "2.14.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "fastify": "5.6.1"
  },
  "devDependencies": {
    "tsx": "4.20.6",
    "typescript": "5.9.3",
    "vitest": "4.0.8"
  }
}
` },
      { path: 'CHANGELOG.md', content: CHANGELOG },
      { path: 'src/server.ts', content: `import Fastify from 'fastify';
import { invoiceRoutes } from './routes/invoices';

const app = Fastify({ logger: true });
app.register(invoiceRoutes, { prefix: '/invoices' });

app.listen({ port: 4010, host: '127.0.0.1' });
` },
      { path: 'src/routes/invoices.ts', content: `import type { FastifyInstance } from 'fastify';
import { computeTotals } from '../invoice/total';
import type { Invoice } from '../invoice/types';

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Invoice }>('/totals', async (request, reply) => {
    if (request.body.lines.length === 0) return reply.code(422).send({ error: 'NO_LINES' });
    return computeTotals(request.body);
  });
}
` },
      { path: 'src/invoice/types.ts', content: `export interface InvoiceLine {
  unitPrice: number;
  quantity: number;
  description?: string;
}

export interface Invoice {
  id: string;
  currency: 'USD' | 'EUR' | 'GBP';
  taxRate: number;
  lines: InvoiceLine[];
}

export interface InvoiceTotals {
  subtotal: number;
  tax: number;
  total: number;
  currency: Invoice['currency'];
}
` },
      { path: 'src/invoice/total.ts', content: TOTAL_TS },
      { path: 'tests/fixtures/invoice.ts', content: `import type { Invoice } from '../../src/invoice/types';

export function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return { id: 'inv_test', currency: 'USD', taxRate: 0, lines: [], ...overrides };
}
` },
      { path: 'tests/invoice/total.test.ts', content: TEST_TS },
    ],
  },
  {
    id: 'atlas-web',
    name: 'atlas-web',
    path: '~/sample-projects/atlas-web',
    branch: 'feat/usage-charts',
    description: 'Customer dashboard — React + Vite',
    language: 'TypeScript · React',
    accent: '#d9822b',
    files: [
      { path: 'README.md', content: `# atlas-web

Customer-facing usage dashboard.
` },
      { path: 'src/App.tsx', content: `import { UsageChart } from './charts/UsageChart';

export function App() {
  return <main><UsageChart range="30d" /></main>;
}
` },
      { path: 'src/charts/UsageChart.tsx', content: `export function UsageChart({ range }: { range: '7d' | '30d' }) {
  return <figure aria-label={\`Usage for \${range}\`} />;
}
` },
    ],
  },
  {
    id: 'ops-runbooks',
    name: 'ops-runbooks',
    path: '~/sample-projects/ops-runbooks',
    branch: 'main',
    description: 'On-call runbooks and incident templates',
    language: 'Markdown',
    accent: '#2f9e72',
    files: [
      { path: 'README.md', content: `# ops-runbooks

Runbooks for the billing platform on-call rotation.
` },
      { path: 'runbooks/ledger-latency.md', content: `# ledger-api latency

1. Check p95 on the invoices dashboard.
2. Compare with the last deploy.
3. Page the owning team if > 800ms for 10 minutes.
` },
    ],
  },
];

export const DEMO_PROJECT_ID = 'ledger-api';
export const DEMO_PROMPT = 'Some multi-line invoices with tax are over-charged by one cent (INC-4821). Find the cause, fix it, and add a regression test.';
