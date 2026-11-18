import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { AGENT_RUN_LIMITS } from '@operation-agent/contracts';

const DNS_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = AGENT_RUN_LIMITS.maxConversationBytes / 4;
const blocked = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['168.63.129.16', 32], // Azure platform virtual IP
] as const) blocked.addSubnet(network, bits, 'ipv4');

const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');
for (const [network, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3ffe::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(network, bits, 'ipv6');

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.') ||
      !globalUnicast.check(address, 'ipv6') || blocked.check(address, 'ipv6')) return false;
  // ISATAP embeds an IPv4 destination behind 0000:5efe or 0200:5efe in the interface ID.
  const [left, right] = address.toLowerCase().split('::');
  const prefix = left ? left.split(':') : [];
  const suffix = right ? right.split(':') : [];
  const words = [...prefix, ...Array<string>(8 - prefix.length - suffix.length).fill('0'), ...suffix];
  return !(Number.parseInt(words[5]!, 16) === 0x5efe && [0, 0x200].includes(Number.parseInt(words[4]!, 16)));
}

function invalid(): never { throw new Error('CUSTOM_ENDPOINT_INVALID'); }

async function resolveEndpoint(baseUrl: string, allowLocal: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Inspect authority before WHATWG normalizes legacy IPv4 spellings, empty userinfo or escapes.
  const authority = /^https?:\/\/([^/]+)/i.exec(baseUrl)?.[1];
  if (!authority || /[@%]/.test(authority) || /[\s\\?#]/.test(baseUrl)) invalid();
  let url: URL;
  try { url = new URL(baseUrl); } catch { return invalid(); }
  if (url.protocol === 'http:') {
    if (allowLocal !== true || !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(authority)) invalid();
    // localhost has a fixed IPv4 meaning for this opt-in, independent of hosts files and DNS.
    return { url, address: '127.0.0.1' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!publicAddress(host)) invalid();
    return { url, address: host };
  }
  if (/(^|\.)(localhost|local|internal)\.?$/i.test(host) || !host.includes('.')) invalid();
  const timeout = AbortSignal.timeout(DNS_TIMEOUT_MS);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const cancelled = new Promise<never>((_, reject) => {
    deadline.onabort = () => reject(deadline.reason);
  });
  try {
    const answers = await Promise.race([dns.lookup(host, { all: true, verbatim: true }), cancelled]);
    if (!answers.length || !answers.every(({ address }) => publicAddress(address))) invalid();
    return { url, address: answers[0]!.address };
  } finally {
    deadline.onabort = null;
  }
}

export async function validateCustomEndpoint(baseUrl: string, allowLocal: boolean): Promise<void> {
  await resolveEndpoint(baseUrl, allowLocal);
}

export async function sendCustomChat(baseUrl: string, allowLocal: boolean, init: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(AGENT_RUN_LIMITS.turnTimeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const { url, address } = await resolveEndpoint(baseUrl, allowLocal, signal);
  signal.throwIfAborted();
  if ((init.method && init.method.toUpperCase() !== 'POST') || (init.body != null && typeof init.body !== 'string')) invalid();
  let headers: Headers;
  // A Headers constructor error can quote a malformed bearer token.
  try { headers = new Headers(init.headers); } catch { return invalid(); }
  for (const name of headers.keys()) {
    if (!['authorization', 'accept', 'content-type'].includes(name)) invalid();
  }
  headers.set('host', url.host);
  const secure = url.protocol === 'https:';
  // A private agent has no proxyEnv or pooled socket. Only the checked IP reaches net.connect.
  const agent = secure ? new https.Agent() : new http.Agent();
  try {
    const incoming = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (secure ? https.request : http.request)({
        hostname: address, port: url.port || (secure ? 443 : 80), agent, signal, method: 'POST',
        path: url.pathname.replace(/\/+$/, '') + '/chat/completions', headers: Object.fromEntries(headers),
        servername: secure && !isIP(url.hostname) && !url.hostname.startsWith('[') ? url.hostname : '',
        rejectUnauthorized: true,
      }, resolve);
      request.on('error', reject);
      request.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('CUSTOM_ENDPOINT_UPGRADE')); });
      request.end(init.body);
    });
    const status = incoming.statusCode!;
    if (status >= 300 && status < 400) throw new Error('CUSTOM_ENDPOINT_REDIRECT');
    if (Number(incoming.headers['content-length']) > MAX_RESPONSE_BYTES) throw new Error('CUSTOM_RESPONSE_TOO_LARGE');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of incoming) {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('CUSTOM_RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
    const responseHeaders = new Headers();
    for (const [name, values] of Object.entries(incoming.headersDistinct)) {
      for (const value of values ?? []) responseHeaders.append(name, value);
    }
    return new Response(bytes ? Buffer.concat(chunks, bytes) : null, { status, headers: responseHeaders });
  } finally {
    agent.destroy();
  }
}
