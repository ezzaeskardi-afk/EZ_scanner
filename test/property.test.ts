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
