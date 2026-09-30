/**
 * Property tests — the parsers answer junk with a reason, never a throw.
 *
 * The hostile-line tests proved the *engine* survives a hostile network; these prove the
 * *front door* survives a hostile paste. Three seeded corpora (test/helpers/fuzz.ts:
 * garbage strings, scheme-prefixed junk, JSON/base64 shapes) plus a hand-picked
 * adversarial list of the shapes that broke these parsers before:
 *
 *   1. no input makes the config/host-list parsers throw — every string yields `{error}`
 *      or a usable result, and every emitted port is a real TCP port (1..65535, never NaN);
 *   2. no input makes `rewriteLink` throw — the GUI rewrites whatever the parser let
 *      through, so the rewriter must survive the same corpus.
 *
 * Every corpus is seeded with `mulberry32` (the scanner's own PRNG), so a failure
 * reproduces from the named seed. The default 300 iterations per corpus run in well under
 * a second; widen the window locally (CI stays at the default for a deterministic suite):
 *
 *   FUZZ_ITERATIONS=5000 FUZZ_SEED=7 node --test test/property.test.ts
 *
 * (`node --test` swallows unknown CLI flags, hence environment variables.)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeConfig,
  extractTargetsFromConfig,
  isParsedConfig,
  parseShareLink,
  parseXrayJson,
  rewriteLink,
  sniRiskWarnings,
} from '../src/core/configparse.ts';
import { DEFAULT_CONFIG, type ScanConfig } from '../src/core/types.ts';
import { normalizeSni, sanitizeConfig } from '../src/core/validate.ts';
import {
  bigToIpv6,
  cidrInfo,
  intToIpv4,
  ipv4ToInt,
  ipv6ToBig,
  isCidr,
  isIpv4,
  isIpv6,
  parseTargetText,
  splitHostPort,
} from '../src/core/ipsrc.ts';
import {
  ADVERSARIAL,
  garbageString,
  intBetween,
  junkConfigPatch,
  junkJson,
  randomCidr,
  schemeGarbage,
  seededFuzz,
} from './helpers/fuzz.ts';

const ITERATIONS = Math.max(1, Number(process.env.FUZZ_ITERATIONS ?? 300) || 300);
const SEED_OFFSET = Number(process.env.FUZZ_SEED ?? 0) || 0;
const BASE_SEED = 20260927 + SEED_OFFSET;

const CORPORA: Array<{ label: string; make: (rand: () => number) => string }> = [
  { label: 'garbage strings', make: garbageString },
  { label: 'scheme-shaped junk', make: schemeGarbage },
  { label: 'JSON and base64 shapes', make: junkJson },
];

/** Everything the config parsers must survive, in one list. */
const everything: string[] = [...ADVERSARIAL];
for (const { make } of CORPORA) {
  const rand = seededFuzz(BASE_SEED);
  for (let i = 0; i < ITERATIONS; i += 1) everything.push(make(rand));
}

/** Keeps a failure message readable: one line, and never the whole 300-char blob. */
function slice(input: string): string {
  const oneLine = input.replace(/\s+/g, ' ');
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

function assertRealPort(port: number, where: string): void {
  assert.ok(Number.isInteger(port), `${where}: port must be an integer, got ${String(port)}`);
  assert.ok(port >= 1 && port <= 65535, `${where}: port must be 1..65535, got ${String(port)}`);
}

/** A warning the sanitizer emitted is a string; anything else would print wrong downstream. */
function assertWarningsAreStrings(warnings: readonly unknown[], where: string): void {
  for (const warning of warnings) {
    assert.equal(typeof warning, 'string', `${where}: every warning is a string, got ${String(warning)}`);
  }
}

/**
 * The whole safety net holds at once: the patch the sanitizer returns is a usable ScanConfig
 * (every integer field whole and in its own legal range, every boolean a boolean, every string
 * a string) and nothing threw to get there.
 */
test('property: sanitizeConfig answers every hostile GUI patch with a usable config', () => {
  const rand = seededFuzz(BASE_SEED + 2);
  const patches: Array<Record<string, unknown>> = [{}, ...ADVERSARIAL.map((text) => ({ mode: text, sni: text, speedUrl: text })), ...Array.from({ length: ITERATIONS }, () => junkConfigPatch(rand))];
  for (const patch of patches) {
    let result: ReturnType<typeof sanitizeConfig> | undefined;
    assert.doesNotThrow(() => {
      result = sanitizeConfig(patch as Partial<ScanConfig>, DEFAULT_CONFIG);
    }, `patch: ${JSON.stringify(slice(JSON.stringify(patch)))}`);
    if (!result) assert.fail('unreachable');
    const { config, warnings } = result;
    assertWarningsAreStrings(warnings, `patch: ${JSON.stringify(slice(JSON.stringify(patch)))}`);
    assertRealPort(config.port, `patch: ${JSON.stringify(slice(JSON.stringify(patch)))}`);
    assertRealPort(config.canaryPort, `patch: ${JSON.stringify(slice(JSON.stringify(patch)))}`);
    for (const [name, value] of Object.entries({
      tries: config.tries, minSuccesses: config.minSuccesses, timeoutMs: config.timeoutMs, workers: config.workers,
      maxLatencyMs: config.maxLatencyMs, maxLossPct: config.maxLossPct, stabilityMs: config.stabilityMs,
      speedBytes: config.speedBytes, topN: config.topN, minDelayMs: config.minDelayMs, canaryPort: config.canaryPort,
      minScore: config.minScore, rateLimitPerSec: config.rateLimitPerSec,
    })) {
      assert.ok(Number.isInteger(value), `${name}=${String(value)} must be an integer (patch: ${JSON.stringify(slice(JSON.stringify(patch)))})`);
    }
    assert.ok(config.tries >= 1 && config.tries <= 10, `tries=${config.tries} is 1..10`);
    assert.ok(config.minSuccesses >= 1 && config.minSuccesses <= config.tries, `minSuccesses=${config.minSuccesses} respects tries=${config.tries}`);
    assert.ok(config.timeoutMs >= 500 && config.timeoutMs <= 30_000, `timeoutMs=${config.timeoutMs} is 500..30000`);
    assert.ok(config.workers >= 1 && config.workers <= 1000, `workers=${config.workers} is 1..1000`);
    assert.ok(config.maxLossPct >= 0 && config.maxLossPct <= 100, `maxLossPct=${config.maxLossPct} is 0..100`);
    for (const [name, value] of Object.entries({ requireHttp: config.requireHttp, requireWs: config.requireWs, earlyExit: config.earlyExit, measureSpeed: config.measureSpeed, recoveryPass: config.recoveryPass })) {
      assert.equal(typeof value, 'boolean', `${name}=${String(value)} must be a boolean (patch: ${JSON.stringify(slice(JSON.stringify(patch)))})`);
    }
    for (const [name, value] of Object.entries({ sni: config.sni, httpPath: config.httpPath, wsPath: config.wsPath, canaryHost: config.canaryHost, speedUrl: config.speedUrl, uploadUrl: config.uploadUrl })) {
      assert.equal(typeof value, 'string', `${name}=${String(value)} must be a string (patch: ${JSON.stringify(slice(JSON.stringify(patch)))})`);
    }
    assert.ok(config.httpPath.startsWith('/'), `httpPath=${config.httpPath} starts with /`);
    assert.ok(config.wsPath.startsWith('/'), `wsPath=${config.wsPath} starts with /`);
    if (config.speedUrl) assert.ok(config.speedUrl.startsWith('http://') || config.speedUrl.startsWith('https://'), `speedUrl=${config.speedUrl} is http(s)`);
    if (config.uploadUrl) assert.ok(config.uploadUrl.startsWith('http://') || config.uploadUrl.startsWith('https://'), `uploadUrl=${config.uploadUrl} is http(s)`);
    assert.ok(config.sniPool.length <= 20, `sniPool has at most 20 members, got ${config.sniPool.length}`);
    assert.ok(config.sniPool.every((sni) => typeof sni === 'string' && sni.length > 0), 'every sniPool member is a non-empty string');
    assert.ok(['tcp', 'tls', 'http'].includes(config.mode), `mode=${config.mode} is a real probe mode`);
    assert.ok([0, 4, 6].includes(config.family), `family=${config.family} is 0, 4 or 6`);
  }
});

test('property: sanitizeConfig accepts good values unchanged — the fuzz must not have broken the front door', () => {
  const rand = seededFuzz(BASE_SEED + 3);
  for (let i = 0; i < ITERATIONS; i += 1) {
    // workers stays under the burst-profile threshold: above 150 with no rate limit the
    // sanitizer *means* to warn — that advisory is intended behavior, not a sanitize failure.
    const want = { workers: intBetween(rand, 1, 150), timeoutMs: intBetween(rand, 500, 30_000), port: intBetween(rand, 1, 65535), sni: `edge${intBetween(rand, 0, 9999)}.example.com` };
    const { config, warnings } = sanitizeConfig(want as Partial<ScanConfig>, DEFAULT_CONFIG);
    assert.deepEqual({ workers: config.workers, timeoutMs: config.timeoutMs, port: config.port, sni: config.sni }, want, 'legal values pass through exactly');
    assert.deepEqual(warnings, []);
  }
});

test('property: normalizeSni answers every string with a host-shaped lowercase answer', () => {
  const rand = seededFuzz(BASE_SEED + 4);
  const inputs = [...ADVERSARIAL, ...Array.from({ length: ITERATIONS }, () => garbageString(rand)), ...Array.from({ length: ITERATIONS }, () => schemeGarbage(rand))];
  for (const input of inputs) {
    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = normalizeSni(input);
    }, `input: ${JSON.stringify(slice(input))}`);
    assert.equal(typeof out, 'string');
    assert.equal(out, (out as string).toLowerCase(), `sni stays lowercase: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('/'), `sni carries no path: ${JSON.stringify(out)}`);
    assert.ok(!/^\./.test(out as string) && !/\.$/.test(out as string), `sni neither starts nor ends on a dot: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('://'), `sni carries no scheme: ${JSON.stringify(out)}`);
    // `vless:` survives the stripper because it never carried `//` — a host-shaped leftover,
    // not a port. The real invariant: no `host:port` pair rides on.
    assert.ok(!/:[0-9]+$/.test(out as string), `sni carries no port: ${JSON.stringify(out)}`);
  }
});

test('property: parseShareLink answers every string with a result or a reason', () => {
  for (const { label, make } of CORPORA) {
    const rand = seededFuzz(BASE_SEED);
    const corpus = [...ADVERSARIAL, ...Array.from({ length: ITERATIONS }, () => make(rand))];
    for (const input of corpus) {
      let parsed: ReturnType<typeof parseShareLink> | undefined;
      assert.doesNotThrow(() => {
        parsed = parseShareLink(input);
      }, `input: ${JSON.stringify(slice(input))}`);
      if (!parsed) assert.fail(`unreachable: ${JSON.stringify(slice(input))}`);
      if (isParsedConfig(parsed)) {
        assertRealPort(parsed.port, `input: ${JSON.stringify(slice(input))}`);
        assert.ok(describeConfig(parsed).length > 0);
        for (const warning of sniRiskWarnings(parsed)) assert.equal(typeof warning, 'string');
      } else {
        assert.equal(typeof parsed.error, 'string');
        assert.ok(parsed.error.length > 0, 'a rejection carries a reason');
      }
    }
  }
});

test('property: extractTargetsFromConfig and parseXrayJson never throw', () => {
  for (const input of everything) {
    let hosts: ReturnType<typeof extractTargetsFromConfig> | undefined;
    assert.doesNotThrow(() => {
      hosts = extractTargetsFromConfig(input);
    }, `input: ${JSON.stringify(slice(input))}`);
    if (!hosts) assert.fail('unreachable');
    assert.ok(Array.isArray(hosts.hosts), 'hosts is an array');
    assert.ok(hosts.hosts.every((h) => typeof h === 'string'));
    if (hosts.error !== undefined) assert.ok(hosts.error.length > 0);

    let configs: ReturnType<typeof parseXrayJson> | undefined;
    assert.doesNotThrow(() => {
      configs = parseXrayJson(input);
    }, `input: ${JSON.stringify(slice(input))}`);
    if (!configs) assert.fail('unreachable');
    assert.ok(Array.isArray(configs));
    for (const config of configs as ReturnType<typeof parseXrayJson>) {
      assert.ok(isParsedConfig(config));
      assertRealPort(config.port, `input: ${JSON.stringify(slice(input))}`);
    }
  }
});

test('property: rewriteLink survives everything the parser survived', () => {
  for (const input of everything) {
    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = rewriteLink(input, '104.16.0.9', 2053, { label: 'EZ-property' });
    }, `input: ${JSON.stringify(slice(input))}`);
    assert.equal(typeof out, 'string', `output: ${JSON.stringify(out)}`);
  }
});

test('property: parseTargetText and splitHostPort never throw', () => {
  for (const input of everything) {
    let parsed: ReturnType<typeof parseTargetText> | undefined;
    assert.doesNotThrow(() => {
      parsed = parseTargetText(input);
    }, `input: ${JSON.stringify(slice(input))}`);
    if (!parsed) assert.fail('unreachable');
    assert.ok(Array.isArray(parsed.entries) && Array.isArray(parsed.errors));
    for (const entry of parsed.entries) {
      assert.equal(typeof entry.host, 'string');
      if (entry.port !== undefined) assertRealPort(entry.port, `input: ${JSON.stringify(slice(input))}`);
    }

    let split: ReturnType<typeof splitHostPort> | undefined;
    assert.doesNotThrow(() => {
      split = splitHostPort(input, 443);
    }, `input: ${JSON.stringify(slice(input))}`);
    if (!split) assert.fail('unreachable');
    // The splitter is a notation reader, not a validator: a 5-digit port it passes through
    // as digits (`1.2.3.4:70000`) is range-checked further down the pipeline. The property
    // here is only that it answers with a string and a whole, finite port.
    assert.equal(typeof split.host, 'string');
    assert.ok(Number.isInteger(split.port) && split.port >= 0, `port ${String(split.port)} is whole`);
  }
});

test('property: the IP classifiers always answer, and cidrInfo agrees with them', () => {
  for (const input of everything) {
    let v4: boolean | undefined;
    let v6: boolean | undefined;
    let cidr: boolean | undefined;
    assert.doesNotThrow(() => {
      v4 = isIpv4(input);
      v6 = isIpv6(input);
      cidr = isCidr(input);
    }, `input: ${JSON.stringify(slice(input))}`);
    assert.equal(typeof v4, 'boolean');
    assert.equal(typeof v6, 'boolean');
    assert.equal(typeof cidr, 'boolean');
    if (cidr) {
      let info: ReturnType<typeof cidrInfo> | undefined;
      assert.doesNotThrow(() => {
        info = cidrInfo(input);
      }, `input: ${JSON.stringify(slice(input))}`);
      if (!info) assert.fail('unreachable');
      assert.ok(info.size >= 1n, 'a valid CIDR spans at least one address');
    }
  }
});

test('property: cidrInfo bounds bracket every pool member, over random pools', () => {
  const rand = seededFuzz(BASE_SEED + 1);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const cidr = randomCidr(rand);
    const info = cidrInfo(cidr);
    assert.ok(info.size >= 1n);
    const toBig = (text: string): bigint => (info!.family === 4 ? BigInt(ipv4ToInt(text)) : ipv6ToBig(text));
    assert.equal(toBig(info.first), info.base, `${cidr}: first is the aligned base`);
    assert.equal(toBig(info.last), info.base + info.size - 1n, `${cidr}: last closes the pool`);
    const member = info.base + BigInt(Math.floor(rand() * Number(info.size)));
    const text = info.family === 4 ? intToIpv4(Number(member)) : bigToIpv6(member);
    assert.equal(toBig(text), member, `${cidr}: a drawn member round-trips`);
  }
});
