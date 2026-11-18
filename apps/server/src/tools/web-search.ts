import { SEARCH_PROVIDERS, WEB_SEARCH_LIMITS } from '@operation-agent/contracts';
import type { SearchProvider, WebSearchArgs, WorkbenchSettings } from '@operation-agent/contracts';
import type { CredentialService } from '../credentials/service.js';
import { readBounded } from '../models/providers.js';
import { WEB_SEARCH_TOOL_REGISTRATION } from './registry.js';

type SearchSettings = Pick<WorkbenchSettings, 'webSearchMode' | 'webSearchProvider'>;
type SearchCredential = Pick<CredentialService, 'status' | 'withKey'>;
type SearchHit = { title: string; url: string; snippet: string };
export type WebSearchFailureCode = 'WEB_SEARCH_DISABLED' | 'WEB_SEARCH_NOT_CONFIGURED' | 'WEB_SEARCH_CREDENTIAL_UNAVAILABLE' |
  'WEB_SEARCH_RATE_LIMITED' | 'WEB_SEARCH_AUTH_FAILED' | 'WEB_SEARCH_INVALID_RESPONSE' | 'WEB_SEARCH_UNREACHABLE' |
  'TIMED_OUT' | 'CANCELLED' | 'VALIDATION_ERROR' | 'WEB_SEARCH_LIMIT_EXCEEDED';
type WebSearchFailure = { status: 'refused' | 'failed'; code: WebSearchFailureCode };
export type WebSearchResult = { status: 'ok'; hits: SearchHit[] } | WebSearchFailure;

export interface SearchGateway {
  selectProvider(): SearchProvider | null;
  search(provider: SearchProvider, args: WebSearchArgs, signal: AbortSignal): Promise<WebSearchResult>;
}

// Provider URLs, authentication, request options, and reply shapes are fixed in Express.
// Search results stay as references. No result URL is opened and no extract/crawl API is used.
const endpoints = {
  exa: 'https://api.exa.ai/search',
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  firecrawl: 'https://api.firecrawl.dev/v2/search',
} satisfies Record<SearchProvider, string>;
const maxReplyBytes = 256 * 1024;
const maxTitleChars = 240;
const maxUrlChars = 2_048;
const maxSnippetChars = 800;

function requestBody(provider: SearchProvider, query: string, count: number): Record<string, unknown> {
  switch (provider) {
    case 'exa': return { query, type: 'lite', numResults: count, contents: { highlights: true } };
    case 'tavily': return { query, search_depth: 'basic', max_results: count, include_raw_content: false };
    case 'brave': return { q: query, count, result_filter: ['web'], text_decorations: false };
    case 'firecrawl': return { query, limit: count, sources: ['web'] };
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function resultRows(provider: SearchProvider, data: unknown): unknown[] | null {
  const reply = object(data);
  if (!reply) return null;
  let rows: unknown;
  switch (provider) {
    case 'exa':
    case 'tavily': rows = reply.results; break;
    case 'brave': rows = object(reply.web)?.results ?? (reply.type === 'search' && reply.web === undefined ? [] : null); break;
    case 'firecrawl': rows = reply.success === true ? object(reply.data)?.web : null; break;
  }
  return Array.isArray(rows) ? rows : null;
}

const clip = (value: unknown, limit: number): string => typeof value === 'string' ? value.trim().slice(0, limit) : '';
function normalize(row: unknown): SearchHit | null {
  const entry = object(row);
  if (!entry || typeof entry.url !== 'string' || entry.url.length > maxUrlChars) return null;
  const url = URL.parse(entry.url);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.href.length > maxUrlChars) return null;
  const highlight = Array.isArray(entry.highlights) ? entry.highlights.find(item => typeof item === 'string') : undefined;
  return { url: url.href, title: clip(entry.title, maxTitleChars) || url.hostname,
    snippet: clip(highlight ?? entry.content ?? entry.description, maxSnippetChars) };
}

const refused = (code: WebSearchFailureCode): WebSearchFailure => ({ status: 'refused', code });
const failed = (code: WebSearchFailureCode): WebSearchFailure => ({ status: 'failed', code });

export function createSearchGateway({ settings, credentials, request = fetch }: {
  settings(): SearchSettings;
  credentials: Record<SearchProvider, SearchCredential>;
  request?: typeof fetch;
}): SearchGateway {
  const permitted = (provider: SearchProvider): boolean => {
    const { webSearchMode, webSearchProvider } = settings();
    return webSearchMode === 'any' || (webSearchMode === 'default' && provider === webSearchProvider);
  };
  return {
    selectProvider() {
      const { webSearchMode, webSearchProvider } = settings();
      if (webSearchMode === 'off') return null;
      if (credentials[webSearchProvider].status().configured) return webSearchProvider;
      return webSearchMode === 'any' ? SEARCH_PROVIDERS.find(provider => credentials[provider].status().configured) ?? null : null;
    },
    async search(provider, args, signal) {
      if (signal.aborted) return failed('CANCELLED');
      if (!permitted(provider)) return refused('WEB_SEARCH_DISABLED');
      // Brave's request rejects queries longer than 75 words even under its character limit.
      if (provider === 'brave' && args.query.split(/\s+/u).length > 75) return refused('VALIDATION_ERROR');
      const credential = credentials[provider];
      const deadline = AbortSignal.timeout(WEB_SEARCH_TOOL_REGISTRATION.timeoutMs);
      const requestSignal = AbortSignal.any([signal, deadline]);
      try {
        const used = await credential.withKey<WebSearchResult>(async key => {
          if (signal.aborted) return failed('CANCELLED');
          if (!permitted(provider)) return refused('WEB_SEARCH_DISABLED');
          if (!credential.status().configured) return refused('WEB_SEARCH_NOT_CONFIGURED');
          if (args.query.includes(key)) return refused('VALIDATION_ERROR');
          const count = args.maxResults ?? WEB_SEARCH_LIMITS.defaultResults;
          const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
          if (provider === 'exa') headers.set('x-api-key', key);
          else if (provider === 'brave') headers.set('x-subscription-token', key);
          else headers.set('authorization', `Bearer ${key}`);
          const response = await request(endpoints[provider], {
            method: 'POST', headers, body: JSON.stringify(requestBody(provider, args.query, count)),
            redirect: 'error', credentials: 'omit', signal: requestSignal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 401 || response.status === 403) return failed('WEB_SEARCH_AUTH_FAILED');
            if (response.status === 429 || response.status === 402) return failed('WEB_SEARCH_RATE_LIMITED');
            return failed('WEB_SEARCH_UNREACHABLE');
          }
          const text = await readBounded(response, maxReplyBytes);
          if (text === null) return failed('WEB_SEARCH_INVALID_RESPONSE');
          let rows: unknown[] | null;
          try { rows = resultRows(provider, JSON.parse(text) as unknown); }
          catch { return failed('WEB_SEARCH_INVALID_RESPONSE'); }
          if (!rows) return failed('WEB_SEARCH_INVALID_RESPONSE');
          const hits: SearchHit[] = [];
          for (const row of rows) {
            const hit = normalize(row);
            if (!hit || Object.values(hit).some(value => value.includes(key))) continue;
            hits.push(hit);
            if (hits.length === count) break;
          }
          return { status: 'ok', hits };
        });
        if (signal.aborted) return failed('CANCELLED');
        if (deadline.aborted) return failed('TIMED_OUT');
        if (used.ok) return used.value;
        return refused(used.reason === 'not_configured' ? 'WEB_SEARCH_NOT_CONFIGURED' : 'WEB_SEARCH_CREDENTIAL_UNAVAILABLE');
      } catch {
        return failed(signal.aborted ? 'CANCELLED' : deadline.aborted ? 'TIMED_OUT' : 'WEB_SEARCH_UNREACHABLE');
      }
    },
  };
}
