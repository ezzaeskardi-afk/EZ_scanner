/**
 * Seeded generators for the property tests.
 *
 * The repo carries no property-testing dependency, so the fuzzers are built on the same
 * seeded PRNG the scanner itself uses (`mulberry32`): every run of the suite replays the
 * exact same corpus, a failure reproduces locally from the seed named in the test, and CI
 * never sees a case a developer cannot. The generators only make strings — the property
 * under test is that the parsers answer every string with a value or a reason, never a
 * throw. (The `UNUSUAL` pool stays off the Arabic block on purpose: the project is
 * English-only by gate, and the interesting inputs for these parsers are structural junk,
 * not any particular script.)
 */
import { mulberry32 } from '../../src/core/ipsrc.ts';

export type Rand = () => number;

export function seededFuzz(seed: number): Rand {
  return mulberry32(seed);
}

export function intBetween(rand: Rand, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

export function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

const JUNK = 'abcXY019:/@#%[]{}?&=.-_\\ \'"`;<>~!$^*,()+|';
const UNUSUAL = '\u00e9\u3042\u2603\u200b\ufeff';

/** A random mostly-printable string, 0..80 chars, with a pinch of non-ASCII. */
export function garbageString(rand: Rand): string {
  const length = intBetween(rand, 0, 80);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += rand() < 0.85 ? JUNK[Math.floor(rand() * JUNK.length)] : UNUSUAL[Math.floor(rand() * UNUSUAL.length)];
  }
  return out;
}

const SCHEMES = ['vless://', 'trojan://', 'vmess://', 'ss://', 'hysteria2://', 'tuic://', 'hy2://', 'http://', ''];

/** A link-shaped prefix followed by junk — the shape a mangled paste actually has. */
export function schemeGarbage(rand: Rand): string {
  return pick(rand, SCHEMES) + garbageString(rand);
}

const JSON_KEYS = [
  'outbounds', 'settings', 'vnext', 'servers', 'address', 'port', 'streamSettings',
  'add', 'tls', 'tag', 'protocol', 'network', 'sni',
];

function jsonValue(rand: Rand, depth: number): unknown {
  const r = rand();
  if (depth <= 0 || r < 0.3) {
    return pick(rand, ['host.example', '', 0, 443, '443', -1, 1.5, true, null, [], {}] as const);
  }
  if (r < 0.6) {
    return Array.from({ length: intBetween(rand, 0, 4) }, () => jsonValue(rand, depth - 1));
  }
  const obj: Record<string, unknown> = {};
  for (let n = intBetween(rand, 0, 4); n > 0; n -= 1) {
    obj[pick(rand, JSON_KEYS)] = jsonValue(rand, depth - 1);
  }
  return obj;
}

/** Valid-ish JSON, truncated JSON, or base64 of junk — the three shapes the JSON paths see. */
export function junkJson(rand: Rand): string {
  const r = rand();
  if (r < 0.7) return JSON.stringify(jsonValue(rand, 3));
  if (r < 0.85) return JSON.stringify(jsonValue(rand, 3)).slice(0, intBetween(rand, 0, 40));
  return Buffer.from(garbageString(rand), 'utf8').toString('base64');
}

export function randomIpv4(rand: Rand): string {
  return [0, 1, 2, 3].map(() => intBetween(rand, 0, 255)).join('.');
}

export function randomIpv6(rand: Rand): string {
  let groups = Array.from({ length: 8 }, () => Math.floor(rand() * 0x10000).toString(16));
  if (rand() < 0.5) {
    // Collapse a random run of groups to zero and write it `::` — half the corpus then
    // exercises the compressed forms the expanders and samplers have to agree on.
    const start = intBetween(rand, 0, 7);
    const len = intBetween(rand, 1, 8 - start);
    groups = groups.map((g, i) => (i >= start && i < start + len ? '0' : g));
    return `${groups.slice(0, start).join(':')}::${groups.slice(start + len).join(':')}`;
  }
  return groups.join(':');
}

export function randomCidr(rand: Rand): string {
  return rand() < 0.5
    ? `${randomIpv4(rand)}/${intBetween(rand, 0, 32)}`
    : `${randomIpv6(rand)}/${intBetween(rand, 0, 128)}`;
}

/**
 * A plausible ScanConfig patch from hostile hands: right keys, wrong universes. The GUI's
 * config endpoint is this generator's real-world reader (`sanitizeConfig(body.config)`),
 * so the shapes cover what JSON POSTing can actually produce — wrong types, wrong ranges,
 * strings that look like numbers, huge magnitudes, NaN/Infinity serialized as null —
 * sprinkled with a few right values so the sanitizer is not only ever refusing.
 */
export function junkConfigPatch(rand: Rand): Record<string, unknown> {
  const NUMERIC_FIELDS = ['port', 'tries', 'minSuccesses', 'timeoutMs', 'workers', 'maxLatencyMs', 'maxLossPct', 'stabilityMs', 'speedBytes', 'topN', 'minDelayMs', 'canaryPort', 'minScore', 'rateLimitPerSec'] as const;
  const BOOL_FIELDS = ['requireHttp', 'requireWs', 'earlyExit', 'measureSpeed', 'recoveryPass', 'adaptiveBackoff'] as const;
  const STRING_FIELDS = ['sni', 'httpPath', 'wsPath', 'canaryHost', 'speedUrl', 'uploadUrl', 'speedSni'] as const;
  const junkString = (): string => pick(rand, ['', ' ', '999999999999999999999', '-1', '0x1f', 'NaN', 'true', '1e999', 'é', '/path', 'not a url', 'https://', 'javascript:alert(1)', '1.2.3.4:99999', ' null ']);
  const junkNumber = (): unknown => pick<unknown>(rand, [intBetween(rand, -50, 70_000), 1e999, NaN, 0, -1, 1.5, '443', 'abc', true, null]);
  const out: Record<string, unknown> = {};
  const fields = [...NUMERIC_FIELDS, ...BOOL_FIELDS, ...STRING_FIELDS, 'mode', 'family', 'sniPool'];
  for (const field of fields) {
    if (rand() >= 0.35) continue;
    if ((NUMERIC_FIELDS as readonly string[]).includes(field)) out[field] = junkNumber();
    else if ((BOOL_FIELDS as readonly string[]).includes(field)) out[field] = pick<unknown>(rand, [true, false, 'true', 'false', '1', '0', 'on', 'off', 'maybe', 0, 1, null]);
    else if (field === 'sniPool') out[field] = rand() < 0.5 ? Array.from({ length: intBetween(rand, 0, 30) }, () => junkString()) : pick<unknown>(rand, [null, 'not-an-array', 42]);
    else if (field === 'family') out[field] = pick<unknown>(rand, [0, 4, 6, '4', 2, -1, 'six', null]);
    else if (field === 'mode') out[field] = pick<unknown>(rand, ['tcp', 'tls', 'http', 'TLS', 'udp', '', 42, null]);
    else out[field] = rand() < 0.7 ? junkString() : garbageString(rand);
  }
  return out;
}

/** Hand-picked members: the shapes that broke these parsers before, plus classic mangling. */
export const ADVERSARIAL: readonly string[] = [
  '',
  ' ',
  '%',
  '%%%',
  '%zz',
  '\u0000',
  '\t\n',
  'vless://',
  'vless://[',
  'vless://u@:0',
  'vless://u@h:0',
  'vless://u@h:99999999999999999999',
  'ss://@',
  'ss://a@',
  'ss://x@2606:4700::1:2053',
  'ss://=====@1.2.3.4:1',
  'vmess://',
  'vmess://####',
  'vmess://eyJhZGQiOiJob3N0In0=',
  'vmess://W1sg',
  'trojan://@',
  'hysteria2://:0?:',
  '{"outbounds":[{"settings":{"vnext":[{"address"',
  '{"outbounds":[{"settings":{"vnext":[{"address":"h","port":"abc"}]}}]}',
  '{"outbounds":null}',
  '{"outbounds":[null]}',
  '{"outbounds":[null,{"protocol":"vless"}]}',
  '[]',
  '{}',
  'null',
  '0',
  `vless://u@h:8443?sni=${'%'.repeat(30)}`,
  'vless://u@h:8443#A%20B%\u00e9\u3042',
  'https://cdn.example.net/%',
  'x'.repeat(300),
];
