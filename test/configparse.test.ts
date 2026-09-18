import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  b64encode,
  describeConfig,
  extractTargetsFromConfig,
  isParsedConfig,
  parseShareLink,
  parseXrayJson,
  rewriteLink,
  sniRiskWarnings,
  toOutboundJson,
} from '../src/core/configparse.ts';

const VLESS =
  'vless://11111111-2222-3333-4444-555555555555@my.example.com:8443?type=ws&security=tls&sni=cdn.example.com&path=%2Fws&host=my.example.com&fp=chrome#MyNode';

test('vless link keeps its transport details', () => {
  const parsed = parseShareLink(VLESS);
  assert.ok(isParsedConfig(parsed));
  assert.equal(parsed.protocol, 'vless');
  assert.equal(parsed.address, 'my.example.com');
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.sni, 'cdn.example.com');
  assert.equal(parsed.network, 'ws');
  assert.equal(parsed.path, '/ws');
  assert.equal(parsed.hostHeader, 'my.example.com');
  assert.equal(parsed.name, 'MyNode');
  assert.match(describeConfig(parsed), /sni=cdn\.example\.com/);
});

test('a name that cannot be percent-decoded does not sink the whole link', () => {
  // `decodeURIComponent` throws on a stray `%`, and it used to run outside any guard: the
  // link came back as `cannot parse vless link: URI malformed`, so the SNI/port/transport
  // the scan needs were lost over a cosmetic label.
  const parsed = parseShareLink(
    'vless://11111111-2222-3333-4444-555555555555@my.example.com:8443?security=tls&sni=cdn.example.com&type=ws#My%20node%',
  );
  assert.ok(isParsedConfig(parsed), 'the link still parses');
  assert.equal(parsed.sni, 'cdn.example.com');
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.network, 'ws');
  assert.equal(parsed.name, 'My node%');

  const plain = parseShareLink('vless://u@1.2.3.4:443?security=tls#plain%20name');
  assert.ok(isParsedConfig(plain));
  assert.equal(plain.name, 'plain name', 'a well-formed escape still decodes');
});

test('trojan link defaults to tls and port 443', () => {
  const parsed = parseShareLink('trojan://pass@front.example.org?security=tls&sni=front.example.org#T');
  assert.ok(isParsedConfig(parsed));
  assert.equal(parsed.port, 443);
  assert.equal(parsed.security, 'tls');
  assert.equal(parsed.sni, 'front.example.org');
});

test('vmess base64 json is decoded and re-encoded', () => {
  const payload = b64encode(
    JSON.stringify({ v: '2', ps: 'Node', add: 'vm.example.com', port: '443', id: 'uuid', net: 'ws', path: '/x', tls: 'tls', sni: 's.example.com' }),
  );
  const parsed = parseShareLink(`vmess://${payload}`);
  assert.ok(isParsedConfig(parsed));
  assert.equal(parsed.address, 'vm.example.com');
  assert.equal(parsed.sni, 's.example.com');
  assert.equal(parsed.path, '/x');

  const rewritten = rewriteLink(`vmess://${payload}`, '1.2.3.4', undefined, { label: 'EZ-1.2.3.4' });
  const again = parseShareLink(rewritten);
  assert.ok(isParsedConfig(again));
  assert.equal(again.address, '1.2.3.4');
  assert.equal(again.name, 'EZ-1.2.3.4');
  assert.equal(again.port, 443);
});

test('shadowsocks link parses but warns that SNI tricks do not apply', () => {
  const parsed = parseShareLink(`ss://${b64encode('aes-128-gcm:secret')}@1.2.3.4:8388#SS`);
  assert.ok(isParsedConfig(parsed));
  assert.equal(parsed.address, '1.2.3.4');
  assert.equal(parsed.port, 8388);
  assert.ok(parsed.warnings.some((w) => /SNI/.test(w)));
});

test('unsupported or broken input returns a readable error', () => {
  const bad = parseShareLink('wireguard://whatever');
  assert.ok(!isParsedConfig(bad));
  assert.match(bad.error, /unsupported scheme/);
  const empty = parseShareLink('');
  assert.ok(!isParsedConfig(empty));
  const badVmess = parseShareLink('vmess://not-base64-json');
  assert.ok(!isParsedConfig(badVmess));
});

test('rewriteLink swaps the address and keeps every other parameter', () => {
  const out = rewriteLink(VLESS, '104.16.1.2', undefined, { label: 'EZ-104.16.1.2-94ms' });
  assert.ok(out.startsWith('vless://11111111-2222-3333-4444-555555555555@104.16.1.2:8443'));
  assert.ok(out.includes('sni=cdn.example.com'));
  assert.ok(out.includes('path=%2Fws'));
  assert.ok(out.endsWith('#EZ-104.16.1.2-94ms'));

  const withPort = rewriteLink(VLESS, '104.16.1.2', 2053);
  assert.ok(withPort.includes('@104.16.1.2:2053'));

  const v6 = rewriteLink(VLESS, '2606:4700::1');
  assert.ok(v6.includes('@[2606:4700::1]:8443'), v6);
});

test('xray JSON outbounds are understood', () => {
  const json = JSON.stringify({
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      {
        protocol: 'vless',
        tag: 'proxy',
        settings: { vnext: [{ address: 'edge.example.com', port: 443 }] },
        streamSettings: { network: 'ws', wsSettings: { path: '/p', headers: { Host: 'edge.example.com' } }, tlsSettings: { serverName: 'tls.example.com' } },
      },
    ],
  });
  const found = parseXrayJson(json);
  assert.equal(found.length, 1);
  assert.equal(found[0].address, 'edge.example.com');
  assert.equal(found[0].sni, 'tls.example.com');
  assert.equal(found[0].path, '/p');
});

test('extractTargetsFromConfig works for links and JSON', () => {
  assert.deepEqual(extractTargetsFromConfig(VLESS).hosts, ['my.example.com']);
  const json = JSON.stringify({ outbounds: [{ protocol: 'trojan', settings: { servers: [{ address: 'j.example.com', port: 443 }] } }] });
  assert.deepEqual(extractTargetsFromConfig(json).hosts, ['j.example.com']);
  assert.ok(extractTargetsFromConfig('nonsense').error);
});

test('using the user own domain as SNI is flagged (issue #48)', () => {
  const risky = parseShareLink('vless://uuid@my.example.com:443?security=tls&sni=my.example.com');
  assert.ok(isParsedConfig(risky));
  assert.ok(sniRiskWarnings(risky).some((w) => /own domain/.test(w)));
  const safe = parseShareLink(VLESS);
  assert.ok(isParsedConfig(safe));
  assert.ok(!sniRiskWarnings(safe).some((w) => /own domain/.test(w)));
});

test('outbound JSON export uses the discovered address', () => {
  const parsed = parseShareLink(VLESS);
  assert.ok(isParsedConfig(parsed));
  const outbound = JSON.parse(toOutboundJson(parsed, '104.16.0.9'));
  assert.equal(outbound.server, '104.16.0.9');
  assert.equal(outbound.server_port, 8443);
  assert.equal(outbound.tls.server_name, 'cdn.example.com');
  assert.equal(outbound.transport.path, '/ws');
});
