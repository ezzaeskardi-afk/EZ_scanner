import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOUDFLARE_V4,
  bigToIpv6,
  buildTargets,
  cidrInfo,
  intToIpv4,
  ipv4ToInt,
  ipv6ToBig,
  isCidr,
  isIpv4,
  isIpv6,
  mulberry32,
  parseTargetText,
  shuffleInPlace,
  splitHostPort,
} from '../src/core/ipsrc.ts';

test('ipv4 helpers round-trip', () => {
  assert.equal(ipv4ToInt('0.0.0.0'), 0);
  assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
  assert.equal(intToIpv4(ipv4ToInt('104.16.132.229')), '104.16.132.229');
});

test('ipv6 helpers round-trip, including compressed and v4-mapped forms', () => {
  const cases = ['2606:4700::1', '2400:cb00:2048:1::6810:84e5', '::1', '2001:db8:0:0:0:0:2:1'];
  for (const ip of cases) {
    assert.equal(bigToIpv6(ipv6ToBig(ip)), ip === '2001:db8:0:0:0:0:2:1' ? '2001:db8::2:1' : ip);
  }
  assert.equal(bigToIpv6(ipv6ToBig('::ffff:104.16.0.1')), '::ffff:6810:1');
  assert.equal(isIpv6('2606:4700::1111'), true);
  assert.equal(isIpv6('104.16.0.1'), false);
});

test('cidrInfo computes bounds', () => {
  const info = cidrInfo('104.16.0.0/13');
  assert.equal(info.first, '104.16.0.0');
  assert.equal(info.last, '104.23.255.255');
  assert.equal(info.size, 524288n);
  assert.equal(cidrInfo('103.21.244.0/22').size, 1024n);
  assert.equal(isCidr('104.16.0.0/33'), false);
  assert.equal(isCidr('104.16.0.0/13'), true);
});

test('parseTargetText understands every accepted notation', () => {
  const parsed = parseTargetText(`
    # comment line
    1.2.3.4
    104.16.0.0/24
    104.17.0.0-104.17.0.2   ; trailing comment
    example.com
    8.8.8.8:8443
    [2606:4700::1111]:2053
    https://cdn.example.net/path
    not a target!!
  `);
  const hosts = parsed.entries.map((e) => e.host);
  assert.ok(hosts.includes('1.2.3.4'));
  assert.ok(hosts.includes('104.16.0.0/24'));
  assert.ok(hosts.includes('104.17.0.0-104.17.0.2'));
  assert.ok(hosts.includes('example.com'));
  assert.ok(hosts.includes('8.8.8.8'));
  assert.ok(hosts.includes('2606:4700::1111'));
  assert.ok(hosts.includes('cdn.example.net'));
  assert.deepEqual(parsed.errors, ['not', 'a', 'target!!']);
  assert.equal(parsed.entries.find((e) => e.host === '8.8.8.8')?.port, 8443);
  assert.equal(parsed.entries.find((e) => e.host === '2606:4700::1111')?.port, 2053);
});

test('buildTargets: cloudflare pool is deterministic, sized and inside the official ranges', async () => {
  const a = await buildTargets({ kind: 'cloudflare', limit: 500, seed: 11 }, { count: 500, family: 4, seed: 11 });
  const b = await buildTargets({ kind: 'cloudflare', limit: 500, seed: 11 }, { count: 500, family: 4, seed: 11 });
  assert.equal(a.targets.length, 500);
  assert.deepEqual(a.targets, b.targets, 'same seed must give the same list');
  assert.equal(new Set(a.targets).size, 500, 'no duplicates');
  for (const ip of a.targets) {
    assert.ok(isIpv4(ip), `${ip} is IPv4`);
    assert.ok(
      CLOUDFLARE_V4.some((range) => {
        const info = cidrInfo(range);
        const n = BigInt(ipv4ToInt(ip));
        return n >= info.base && n <= info.base + info.size - 1n;
      }),
      `${ip} is inside an official range`,
    );
  }
});

test('buildTargets: tiny CIDRs are enumerated, huge ones sampled', async () => {
  const small = await buildTargets({ kind: 'paste', text: '10.0.0.0/30' }, { count: 0, family: 4 });
  assert.deepEqual(new Set(small.targets), new Set(['10.0.0.0', '10.0.0.1', '10.0.0.2', '10.0.0.3']));

  const big = await buildTargets({ kind: 'paste', text: '10.0.0.0/8' }, { count: 25, family: 4, seed: 3 });
  assert.equal(big.targets.length, 25);
});

test('buildTargets: ranges, ports, family filter and domains', async () => {
  const mixed = await buildTargets(
    { kind: 'paste', text: '104.17.0.0-104.17.0.4\n104.18.0.0/30\n[2606:4700::1]:2053\nfoo.example' },
    {
      count: 0,
      family: 0,
      resolve: async () => ['203.0.113.7'],
    },
  );
  assert.ok(mixed.targets.includes('104.17.0.0'));
  assert.ok(mixed.targets.includes('104.18.0.3'));
  assert.ok(mixed.targets.includes('[2606:4700::1]:2053'));
  assert.ok(mixed.targets.includes('203.0.113.7'));
  assert.equal(mixed.resolved, 1);

  const v6only = await buildTargets({ kind: 'paste', text: '104.16.0.0/30\n2606:4700::1' }, { count: 0, family: 6 });
  assert.ok(v6only.targets.every((t) => isIpv6(t)));

  const failedDns = await buildTargets({ kind: 'paste', text: 'nope.example' }, { count: 0, family: 4, resolve: async () => [] });
  assert.equal(failedDns.targets.length, 0);
  assert.match(failedDns.errors[0], /DNS failed/);
});

test('buildTargets: a domain with a port is resolved and keeps its port', async () => {
  // `my.host:8443` used to be pushed through as the literal string "my.host:8443", which is
  // not a hostname (and not an `ip:port` pair), so every probe of it failed at DNS with the
  // source reporting no error at all.
  const seen: string[] = [];
  const v4 = await buildTargets(
    { kind: 'paste', text: 'my.host:8443\nmy.host' },
    {
      count: 0,
      family: 0,
      resolve: async (host) => {
        seen.push(host);
        return ['203.0.113.7'];
      },
    },
  );
  assert.deepEqual(seen, ['my.host', 'my.host'], 'the resolver gets the bare host, not host:port');
  assert.ok(v4.targets.includes('203.0.113.7:8443'), 'the port survives resolution');
  assert.ok(v4.targets.includes('203.0.113.7'), 'the portless entry still works');
  assert.equal(v4.resolved, 2);
  assert.deepEqual(v4.errors, []);

  const v6 = await buildTargets(
    { kind: 'paste', text: 'my.host:2053' },
    { count: 0, family: 0, resolve: async () => ['2606:4700::1111'] },
  );
  assert.deepEqual(v6.targets, ['[2606:4700::1111]:2053'], 'IPv6 answers are bracketed with their port');
});

test('buildTargets: an explicit count wins over the size ceiling', async () => {
  // 200 /24s expand to 51 200 addresses. Asking for 40 must return 40 — the ceiling used
  // to be applied to the freshly built list, so a big source failed outright with "target
  // list is too large" and the requested count never got a chance to trim it.
  const text = Array.from({ length: 200 }, (_, i) => `10.${Math.floor(i / 256)}.${i % 256}.0/24`).join('\n');
  const trimmed = await buildTargets({ kind: 'paste', text }, { count: 40, family: 4, maxTargets: 10_000 });
  assert.equal(trimmed.targets.length, 40);
  assert.match(trimmed.notes.join(' '), /trimmed 51160 addresses to respect count=40/);

  // Without a count there is nothing to trim to, so the ceiling still rejects the list.
  await assert.rejects(
    () => buildTargets({ kind: 'paste', text }, { count: 0, family: 4, maxTargets: 10_000 }),
    /target list is too large \(51200 addresses\)/,
  );
});

test('splitHostPort handles v4, v6 and plain hosts', () => {
  assert.deepEqual(splitHostPort('1.2.3.4:8443', 443), { host: '1.2.3.4', port: 8443 });
  assert.deepEqual(splitHostPort('[2606:4700::1]:2053', 443), { host: '2606:4700::1', port: 2053 });
  assert.deepEqual(splitHostPort('2606:4700::1', 443), { host: '2606:4700::1', port: 443 });
  assert.deepEqual(splitHostPort('1.2.3.4', 8443), { host: '1.2.3.4', port: 8443 });
});

test('seeded RNG + shuffle are reproducible', () => {
  const a = shuffleInPlace([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(9));
  const b = shuffleInPlace([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(9));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
});
