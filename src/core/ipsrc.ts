/**
 * Candidate address sources: official Cloudflare ranges, arbitrary IP text,
 * CIDR / ranges / domains.
 */
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceSpec } from './types.ts';

/** Official list, mirrored from https://www.cloudflare.com/ips-v4 (verified 2026-09-16). */
export const CLOUDFLARE_V4: string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

const CLOUDFLARE_V6: string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/**
 * Best-effort extra prefixes (WARP endpoints and other Cloudflare anycast
 * blocks). Hit-rate is measurably lower than the official ranges, which is why
 * this file is opt-in (`--extended` / GUI switch) instead of being merged in.
 */
const EXTENDED_DEFAULT: string[] = [
  '162.159.192.0/24',
  '162.159.193.0/24',
  '162.159.195.0/24',
];

let extraCache: string[] | null = null;

/** Reads `src/core/data/extra-ranges.txt` (one CIDR per line, `#` comments ok). */
async function loadExtraRanges(): Promise<string[]> {
  if (extraCache) return extraCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, 'data', 'extra-ranges.txt'), 'utf8');
    extraCache = parseTargetText(raw).entries.filter((e) => isCidr(e.host)).map((e) => e.host);
  } catch {
    extraCache = [...EXTENDED_DEFAULT];
  }
  return extraCache;
}

export interface Target {
  /** IP literal, CIDR, IP range or domain name. */
  host: string;
  /** Per-entry port override from `ip:port` notation. */
  port?: number;
  /** Per-entry SNI override, only used by the `ping` style commands. */
  sni?: string;
}

interface ParseResult {
  entries: Target[];
  errors: string[];
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR_V4_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;
const RANGE_V4_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*-\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9\u0600-\u06ff](?:[a-z0-9\u0600-\u06ff-]{0,61}[a-z0-9\u0600-\u06ff])?\.)+[a-z\u0600-\u06ff]{2,}$/i;

export function isIpv4(s: string): boolean {
  if (!IPV4_RE.test(s)) return false;
  return s.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
}

export function isIpv6(s: string): boolean {
  if (!s.includes(':')) return false;
  try {
    ipv6ToBig(s);
    return true;
  } catch {
    return false;
  }
}

function isIp(s: string): boolean {
  return isIpv4(s) || isIpv6(s);
}

export function isCidr(s: string): boolean {
  const [addr, bits] = s.split('/');
  if (!addr || bits === undefined) return false;
  const n = Number(bits);
  if (!Number.isInteger(n)) return false;
  if (isIpv4(addr)) return n >= 0 && n <= 32;
  if (isIpv6(addr)) return n >= 0 && n <= 128;
  return false;
}

/* ---------------------------------- IPv4 math --------------------------------- */

export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/* ---------------------------------- IPv6 math --------------------------------- */

export function ipv6ToBig(ip: string): bigint {
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%')) s = s.split('%')[0];
  const v4Tail = s.includes('.') ? s.slice(s.lastIndexOf(':') + 1) : null;
  if (v4Tail) {
    if (!isIpv4(v4Tail)) throw new Error(`bad ipv6 ${ip}`);
    const n = ipv4ToInt(v4Tail);
    s = `${s.slice(0, s.lastIndexOf(':'))}:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) throw new Error(`bad ipv6 ${ip}`);
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) throw new Error(`bad ipv6 ${ip}`);
  if (missing < 0) throw new Error(`bad ipv6 ${ip}`);
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) throw new Error(`bad ipv6 ${ip}`);
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) throw new Error(`bad ipv6 ${ip}`);
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

export function bigToIpv6(v: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((v >> BigInt(i * 16)) & 0xffffn).toString(16));
  // compress the longest run of zero groups
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === '0') {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const len = i - start;
      if (len > bestLen) {
        bestLen = len;
        bestStart = start;
      }
      start = -1;
    }
  }
  if (bestLen >= 2) {
    const head = groups.slice(0, bestStart).join(':');
    const tail = groups.slice(bestStart + bestLen).join(':');
    return `${head}::${tail}`;
  }
  return groups.join(':');
}

/* --------------------------------- CIDR helpers -------------------------------- */

interface CidrInfo {
  family: 4 | 6;
  base: bigint;
  bits: number;
  size: bigint;
  first: string;
  last: string;
}

export function cidrInfo(cidr: string): CidrInfo {
  const [addr, bitStr] = cidr.split('/');
  const bits = Number(bitStr);
  const family: 4 | 6 = isIpv4(addr) ? 4 : 6;
  const width = family === 4 ? 32 : 128;
  const raw = family === 4 ? BigInt(ipv4ToInt(addr)) : ipv6ToBig(addr);
  const hostBits = BigInt(width - bits);
  const size = 1n << hostBits;
  const base = (raw >> hostBits) << hostBits;
  const fmt = family === 4 ? (v: bigint) => intToIpv4(Number(v)) : (v: bigint) => bigToIpv6(v);
  return { family, base, bits, size, first: fmt(base), last: fmt(base + size - 1n) };
}

/* ------------------------------------ RNG ------------------------------------- */

/** Deterministic PRNG so a scan can be reproduced from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/* --------------------------------- text parsing -------------------------------- */

/**
 * Parses free-form text. Accepts one target per line (or comma separated),
 * `#`/`//`/`;` comments, `ip`, `ip:port`, `[v6]:port`, CIDR, `a-b` ranges and
 * plain domain names.
 */
export function parseTargetText(text: string): ParseResult {
  const entries: Target[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const tokens = text
    .replace(/\r/g, '\n')
    .split(/[\n,]+/)
    // `#`, `//` and `;` all start a comment.
    .map((line) => line.replace(/(^|\s)(#|\/\/|;).*$/, '').trim())
    .filter(Boolean);

  for (const raw of tokens) {
    for (const token of raw.split(/\s+/)) {
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      const parsed = parseSingleTarget(token);
      if (!parsed) {
        errors.push(token);
        continue;
      }
      seen.add(key);
      entries.push(parsed);
    }
  }
  return { entries, errors };
}

function parseSingleTarget(token: string): Target | null {
  if (isCidr(token)) return { host: token };
  if (RANGE_V4_RE.test(token)) return { host: token.replace(/\s+/g, '') };
  if (isIpv4(token)) return { host: token };
  if (isIpv6(token)) return { host: token };

  // [v6]:port
  const v6Port = token.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6Port && isIpv6(v6Port[1])) return { host: v6Port[1], port: Number(v6Port[2]) };

  // host:port (v4 or domain)
  const hostPort = token.match(/^([^:/\s]+):(\d{1,5})$/);
  if (hostPort && (isIpv4(hostPort[1]) || DOMAIN_RE.test(hostPort[1]))) {
    const port = Number(hostPort[2]);
    if (port < 1 || port > 65535) return null;
    return { host: hostPort[1], port };
  }

  // protocol-ish leftovers such as https://host
  const url = token.match(/^[a-z][a-z0-9+.-]*:\/\/([^/\s:]+)(?::(\d+))?/i);
  if (url && (isIpv4(url[1]) || DOMAIN_RE.test(url[1]))) {
    return { host: url[1], port: url[2] ? Number(url[2]) : undefined };
  }

  if (DOMAIN_RE.test(token)) return { host: token };
  return null;
}

/* -------------------------------- target building ------------------------------ */

interface BuildResult {
  targets: string[];
  errors: string[];
  notes: string[];
  ranges: number;
  resolved: number;
}

/** How many addresses a range may expand to before we switch to random sampling. */
const ENUMERATE_LIMIT = 4096;
/** Hard ceiling so a pasted /8 cannot exhaust memory. */
const MAX_TARGETS = 2_000_000;

interface BuildOptions {
  /** Total address budget (0 = expand everything that is enumerable). */
  count: number;
  family: 4 | 6 | 0;
  seed?: number;
  /** Per-CIDR ceiling so a single /8 cannot eat the whole budget. */
  perCidr?: number;
  /** Resolver for domain entries (injectable for tests). */
  resolve?: (host: string, family: 4 | 6 | 0) => Promise<string[]>;
}

/**
 * Turns a `SourceSpec` into the concrete, de-duplicated address list that the
 * scanner walks. Ordering is randomised but fully determined by `seed`.
 */
export async function buildTargets(source: SourceSpec, opts: BuildOptions): Promise<BuildResult> {
  const errors: string[] = [];
  const notes: string[] = [];
  const rand = mulberry32(source.seed ?? opts.seed ?? 1337);
  const pools: { first: bigint; size: bigint; family: 4 | 6 }[] = [];
  const fixed: string[] = [];
  const domains: string[] = [];
  let rangeCount = 0;

  const addEntry = (host: string, forceSample = false) => {
    if (isIp(host)) {
      fixed.push(host);
      return;
    }
    if (isCidr(host)) {
      const info = cidrInfo(host);
      if (opts.family !== 0 && info.family !== opts.family) return;
      rangeCount++;
      if (!forceSample && info.size <= BigInt(ENUMERATE_LIMIT)) {
        const max = opts.perCidr ? Math.min(Number(info.size), opts.perCidr) : Number(info.size);
        const all: string[] = [];
        for (let i = 0; i < max; i++) {
          const v = info.base + BigInt(i);
          all.push(info.family === 4 ? intToIpv4(Number(v)) : bigToIpv6(v));
        }
        fixed.push(...all);
      } else {
        pools.push({ first: info.base, size: info.size, family: info.family });
      }
      return;
    }
    const range = host.match(RANGE_V4_RE);
    if (range) {
      const a = ipv4ToInt(range[1]);
      const b = ipv4ToInt(range[2]);
      if (b < a) {
        errors.push(host);
        return;
      }
      rangeCount++;
      if (!forceSample && b - a + 1 <= ENUMERATE_LIMIT) {
        for (let v = a; v <= b; v++) fixed.push(intToIpv4(v));
      } else {
        pools.push({ first: BigInt(a), size: BigInt(b - a + 1), family: 4 });
      }
      return;
    }
    domains.push(host);
  };

  if (source.kind === 'cloudflare') {
    const v4 = CLOUDFLARE_V4;
    const v6 = CLOUDFLARE_V6;
    if (source.extended) {
      const extra = await loadExtraRanges();
      notes.push(`extended pool: +${extra.length} non-official prefixes (lower hit-rate)`);
      for (const r of extra) addEntry(r, true);
    }
    // Cloudflare's own ranges are always sampled proportionally to their size,
    // which keeps the sweep uniform over the whole announced space.
    if (opts.family !== 6) for (const r of v4) addEntry(r, true);
    if (opts.family !== 4) for (const r of v6) addEntry(r, true);
  } else {
    let text = source.text ?? '';
    if (source.kind === 'file' && source.path) {
      try {
        text = await readFile(source.path, 'utf8');
      } catch (err) {
        errors.push(`cannot read ${source.path}: ${(err as Error).message}`);
        return { targets: [], errors, notes, ranges: 0, resolved: 0 };
      }
    }
    if (source.kind === 'config') {
      const { extractTargetsFromConfig } = await import('./configparse.ts');
      const parsed = extractTargetsFromConfig(source.config ?? '');
      if (parsed.error) errors.push(parsed.error);
      text = [text, ...parsed.hosts].join('\n');
    }
    const parsed = parseTargetText(text);
    errors.push(...parsed.errors);
    for (const e of parsed.entries) {
      if (e.port !== undefined) {
        fixed.push(isIpv6(e.host) ? `[${e.host}]:${e.port}` : `${e.host}:${e.port}`);
      } else {
        addEntry(e.host);
      }
    }
  }

  let resolved = 0;
  if (domains.length) {
    const resolver = opts.resolve ?? defaultResolve;
    const results = await Promise.all(domains.map((d) => resolver(d, opts.family).catch(() => [])));
    results.forEach((ips, i) => {
      if (!ips.length) {
        errors.push(`${domains[i]} (DNS failed)`);
        return;
      }
      resolved++;
      for (const ip of ips) {
        if (!isIp(ip)) continue;
      }
      fixed.push(...ips.filter(isIp));
    });
  }

  // Budget samples across ranges proportionally to their size.
  const sampled: string[] = [];
  const budget = Math.max(0, Math.floor(source.limit ?? opts.count));
  const draw = (pool: (typeof pools)[number]): string => {
    const v = pool.first + randomBig(pool.size, rand);
    return pool.family === 4 ? intToIpv4(Number(v)) : bigToIpv6(v);
  };
  if (pools.length) {
    const totalSize = pools.reduce((acc, p) => acc + p.size, 0n);
    if (budget > 0) {
      const remaining = Math.max(0, budget - fixed.length);
      for (const pool of pools) {
        const share = remaining === 0 ? 0 : Number((pool.size * BigInt(remaining)) / totalSize);
        for (let i = 0; i < share; i++) sampled.push(draw(pool));
      }
      // Rounding can leave a few slots open — top them up from random ranges so
      // the requested count is actually honoured.
      let guard = remaining * 4 + 64;
      while (sampled.length < remaining && guard-- > 0) {
        const pool = pools[Math.floor(rand() * pools.length)];
        if (pool) sampled.push(draw(pool));
      }
    } else {
      // No budget: one address per range keeps the set representative.
      for (const pool of pools) sampled.push(draw(pool));
      notes.push('no count given: sampled one address per range');
    }
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [...fixed, ...sampled]) {
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  // Random sampling can collide, so top up until the requested count is real.
  let topUpGuard = budget * 20 + 1000;
  while (budget > 0 && merged.length < budget && pools.length && topUpGuard-- > 0) {
    const pool = pools[Math.floor(rand() * pools.length)];
    if (!pool) break;
    const candidate = draw(pool);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    merged.push(candidate);
  }
  if (merged.length > MAX_TARGETS) {
    throw new Error(`target list is too large (${merged.length}); pass a smaller count or narrower ranges`);
  }
  shuffleInPlace(merged, rand);
  const limited = budget > 0 ? merged.slice(0, budget) : merged;
  if (merged.length > limited.length) {
    notes.push(`trimmed ${merged.length - limited.length} addresses to respect count=${budget}`);
  }
  return { targets: limited, errors, notes, ranges: rangeCount, resolved };
}

function randomBig(size: bigint, rand: () => number): bigint {
  if (size <= 1n) return 0n;
  // 53 bits of randomness per draw is plenty for a sample offset.
  const hi = BigInt(Math.floor(rand() * 0x2000000)) << 26n;
  const lo = BigInt(Math.floor(rand() * 0x4000000));
  return (hi | lo) % size;
}

let sharedResolver: dns.promises.Resolver | null = null;
function getResolver(): dns.promises.Resolver {
  if (!sharedResolver) sharedResolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  return sharedResolver;
}

export async function defaultResolve(host: string, family: 4 | 6 | 0): Promise<string[]> {
  const out = new Set<string>();
  // getaddrinfo first: it honours the OS resolver, the hosts file and any VPN
  // DNS, which `dns.Resolver` (c-ares with resolv.conf) can miss on Windows.
  try {
    const records = await dns.promises.lookup(host, { all: true, verbatim: true, family: family === 0 ? 0 : family });
    for (const record of records) out.add(record.address);
  } catch {
    /* fall through to the explicit resolver below */
  }
  if (out.size) return [...out];

  const resolver = getResolver();
  const wants: ('A' | 'AAAA')[] = family === 4 ? ['A'] : family === 6 ? ['AAAA'] : ['A', 'AAAA'];
  for (const kind of wants) {
    try {
      const rec = kind === 'A' ? await resolver.resolve4(host) : await resolver.resolve6(host);
      for (const ip of rec) out.add(ip);
    } catch {
      /* ignore, the other family may still answer */
    }
  }
  return [...out];
}

/** Splits `1.2.3.4:8443` / `[2606:4700::1]:443` / `1.2.3.4` into host + port. */
export function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  const v6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) return { host: v6[1], port: Number(v6[2]) };
  if (isIpv6(value)) return { host: value, port: fallbackPort };
  const m = value.match(/^(.+):(\d{1,5})$/);
  if (m && isIpv4(m[1])) return { host: m[1], port: Number(m[2]) };
  return { host: value, port: fallbackPort };
}
