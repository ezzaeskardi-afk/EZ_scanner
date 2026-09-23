import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportResults, summarize, toCsv, toHosts, toLinks, toTxt, toXlsx } from '../src/core/export.ts';
import { createResult, finalizeAll, recordAttempt } from '../src/core/scoring.ts';
import { DEFAULT_CONFIG, type IpResult, type ScanConfig } from '../src/core/types.ts';
import { createZip, crc32 } from '../src/core/zip.ts';
import { normalizeSni, sanitizeConfig, sanitizeSource } from '../src/core/validate.ts';

const cfg: ScanConfig = { ...DEFAULT_CONFIG, tries: 1, minSuccesses: 1, minScore: 0 };

function sample(ip: string, latency: number, extra: Partial<IpResult> = {}): IpResult {
  const r = createResult(ip, 443, 'sni.example');
  recordAttempt(r, { ok: true, latencyMs: latency, httpStatus: 200, colo: 'FRA' });
  finalizeAll([r], cfg);
  Object.assign(r, extra);
  return r;
}

test('csv is BOM prefixed, quoted and complete', () => {
  const rows = [sample('104.16.0.1', 120), sample('104.16.0.2', 800, { reasons: ['loss 60% > 50%', 'why, "quoted"'] })];
  const csv = toCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'), 'BOM for Excel');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('ip,port,sni,healthy'));
  assert.ok(lines[1].startsWith('104.16.0.1,443,sni.example,yes'));
  assert.ok(lines[2].includes('"loss 60% > 50%; why, ""quoted"""'), lines[2]);
});

test('the csv carries the recovery flag', () => {
  // `recovered` marks the addresses found on the recovery pass's second chance — the difference
  // between a lucky sweep and a line that blocked part of it. The JSON export serialises the whole
  // record, so it always had the flag; the CSV/XLSX columns did not, and those are what people
  // paste into their client.
  const lines = toCsv([sample('104.16.0.1', 100), sample('104.16.0.2', 110, { recovered: true })]) .trim().split('\r\n');
  // Read by name rather than from the end: `down_trust`/`up_trust` follow it, and a column that
  // moves is not a column that went missing.
  const header = lines[0].split(',');
  const at = header.indexOf('recovered');
  assert.ok(at >= 0, 'the column is there');
  assert.equal(lines[1].split(',')[at], 'no');
  assert.equal(lines[2].split(',')[at], 'yes');
});

test('txt/hosts/links outputs are paste-ready', () => {
  const rows = [sample('104.16.0.1', 100), sample('2606:4700::1', 200)];
  assert.equal(toTxt(rows), '104.16.0.1:443\n[2606:4700::1]:443\n');
  assert.equal(toTxt(rows, true), '104.16.0.1\n2606:4700::1\n');
  assert.equal(toHosts(rows), '104.16.0.1\n2606:4700::1\n');

  const links = toLinks(rows, { template: 'vless://uuid@host:443?security=tls&sni=s.example#x', labelPrefix: 'EZ', port: 2053 });
  const lines = links.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('vless://uuid@104.16.0.1:2053'));
  assert.ok(lines[0].includes('#EZ-104.16.0.1-100ms'));
  assert.ok(links.includes('@[2606:4700::1]:2053'));
});

test('links export refuses to run without a template', () => {
  assert.throws(() => toLinks([sample('1.1.1.1', 100)], {}), /no config template/);
});

test('links export refuses a template that cannot carry an address', () => {
  // The rewriter answers "the template unchanged" when it does not understand the input, and the
  // export used to take that at face value: pasting an Xray/v2ray JSON document (not a link) into
  // the template box wrote one copy of that JSON per address. A template that cannot hold an
  // address is an error, not an export.
  const json = JSON.stringify({ outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: 'orig.example', port: 443 }] } }] });
  assert.throws(() => toLinks([sample('1.1.1.1', 100)], { template: json }), /cannot carry an address/);
  assert.throws(() => toLinks([sample('1.1.1.1', 100)], { template: 'ss://not-a-body' }), /cannot carry an address/);
});

test('a shadowsocks template exports the discovered address, not the old one', () => {
  const template = `ss://${Buffer.from('aes-128-gcm:secret@1.2.3.4:8388', 'utf8').toString('base64')}`;
  const links = toLinks([sample('104.16.0.1', 100), sample('104.16.0.2', 110)], { template, labelPrefix: 'EZ' });
  const lines = links.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0], lines[1], 'each row is its own config, not two copies of the template');
  // The address lives inside the encoding, so the check is on the decoded body — which is exactly
  // what the exported link's client will read.
  const decode = (line: string): string =>
    Buffer.from(line.slice('ss://'.length).split('#')[0]!, 'base64').toString('utf8');
  assert.match(decode(lines[0]!), /@104\.16\.0\.1:8388$/, decode(lines[0]!));
  assert.match(decode(lines[1]!), /@104\.16\.0\.2:8388$/);
  assert.ok(!links.includes('1.2.3.4'), 'the server the template came from is gone from the output');
});

test('exportResults picks filenames and content types', () => {
  const rows = [sample('104.16.0.1', 100)];
  const csv = exportResults(rows, 'csv');
  assert.match(csv.filename, /^ez-scanner-.*\.csv$/);
  assert.match(csv.contentType, /text\/csv/);
  const xlsx = exportResults(rows, 'xlsx');
  assert.match(xlsx.filename, /\.xlsx$/);
  assert.ok(Buffer.isBuffer(xlsx.body));
  const json = JSON.parse(exportResults(rows, 'json').body as string);
  assert.equal(json.count, 1);
  assert.equal(json.results[0].ip, '104.16.0.1');
  assert.throws(() => exportResults(rows, 'nope' as never), /unknown export format/);
});

test('healthyOnly filter applies to every format', () => {
  const healthy = sample('104.16.0.1', 100);
  const bad = createResult('104.16.0.9', 443, 'sni.example');
  const rows = [healthy, bad];
  const payload = exportResults(rows, 'txt', { healthyOnly: true });
  assert.equal(payload.body, '104.16.0.1:443\n');
});

test('summarize describes the result set', () => {
  const text = summarize([sample('104.16.0.1', 100, { downMbps: 42 })]);
  assert.match(text, /1 reachable/);
  assert.match(text, /top speed 42 Mbps/);
});

test('zip writer produces a structurally valid archive', () => {
  assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
  const zip = createZip([
    { name: 'a.txt', data: 'alpha' },
    { name: 'nested/b.txt', data: Buffer.from('beta') },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local header signature');
  const eocd = zip.subarray(zip.length - 22);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50, 'end of central directory');
  assert.equal(eocd.readUInt16LE(8), 2, 'two entries recorded');
  assert.equal(eocd.readUInt16LE(10), 2);
  assert.ok(eocd.readUInt32LE(16) < zip.length, 'central directory offset is inside the file');
});

test('xlsx contains the expected parts and rows', () => {
  const rows = [sample('104.16.0.1', 120), sample('104.16.0.2', 130)];
  const xlsx = toXlsx(rows);
  const text = xlsx.toString('latin1');
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', '_rels/.rels']) {
    assert.ok(text.includes(part), `${part} missing`);
  }
  const sheet = text.slice(text.indexOf('<sheetData>'));
  assert.equal((sheet.match(/<row /g) ?? []).length, 3, 'header + 2 rows');
  assert.ok(sheet.includes('104.16.0.1'));
});

test('sanitizeConfig clamps hostile values and warns about strict gates', () => {
  const { config, warnings } = sanitizeConfig({
    workers: 99999,
    timeoutMs: 1,
    tries: 50,
    minSuccesses: 99,
    maxLossPct: 500,
    port: 0,
    mode: 'bogus' as never,
    sni: 'https://My.Example.com/path:443/',
    family: 7 as never,
  });
  assert.equal(config.workers, 1000);
  assert.equal(config.timeoutMs, 500);
  assert.equal(config.tries, 10);
  assert.equal(config.minSuccesses, 10);
  assert.equal(config.maxLossPct, 100);
  assert.equal(config.port, DEFAULT_CONFIG.port);
  assert.equal(config.mode, DEFAULT_CONFIG.mode);
  assert.equal(config.sni, 'my.example.com');
  assert.equal(config.family, 4);
  assert.ok(warnings.some((w) => /unknown probe mode/.test(w)));
  assert.ok(warnings.some((w) => /workers/.test(w)));
});

test('a malformed speed or upload URL is refused with a warning, not silently swapped', () => {
  // The old check was `/^https?:\/\//`, which accepts `https://` — a value the URL parser refuses. The
  // throughput phase then asked for an endpoint that cannot exist (`resolveSpeedUrl` used to fall
  // back to Cloudflare's own in silence, so the row was measured against a host the user never
  // named), and the upload URL dropped the value without even a warning. Both are full-URL checks
  // now, and both say so.
  const base = { ...DEFAULT_CONFIG };
  const badSpeed = sanitizeConfig({ speedUrl: 'https://' }, base);
  assert.equal(badSpeed.config.speedUrl, base.speedUrl, 'the previous value is kept');
  assert.ok(
    badSpeed.warnings.some((w) => /speed URL must be a full http\(s\) URL/.test(w)),
    badSpeed.warnings.join(' | '),
  );

  const badUpload = sanitizeConfig({ uploadUrl: 'not-a-url' }, base);
  assert.equal(badUpload.config.uploadUrl, base.uploadUrl);
  assert.ok(
    badUpload.warnings.some((w) => /upload URL must be a full http\(s\) URL/.test(w)),
    badUpload.warnings.join(' | '),
  );

  const good = sanitizeConfig({ speedUrl: 'https://my.endpoint/__down?bytes=%BYTES%' }, base);
  assert.equal(good.config.speedUrl, 'https://my.endpoint/__down?bytes=%BYTES%', 'the placeholder survives');
  assert.ok(!good.warnings.some((w) => /URL/.test(w)), good.warnings.join(' | '));
});

test('sanitizeConfig warns about the known "everything is red" combinations', () => {
  const ws = sanitizeConfig({ requireWs: true });
  assert.ok(ws.warnings.some((w) => /require-WS/.test(w)));
  const idle = sanitizeConfig({ stabilityMs: 1500 });
  assert.ok(idle.warnings.some((w) => /idle hold/.test(w)));
  const tcp = sanitizeConfig({ mode: 'tcp', requireHttp: true });
  assert.ok(tcp.warnings.some((w) => /tcp.*ignores/.test(w)));
  const noSni = sanitizeConfig({ sni: '' });
  assert.ok(noSni.warnings.some((w) => /no SNI/.test(w)));
});

test('normalizeSni strips schemes, ports and paths', () => {
  assert.equal(normalizeSni('https://X.Example.com/foo'), 'x.example.com');
  assert.equal(normalizeSni('  .example.com:8443 '), 'example.com');
});

test('sanitizeSource keeps the kind sane and clamps the limit', () => {
  const src = sanitizeSource({ kind: 'nonsense' as never, limit: 10 ** 9, seed: -5 });
  assert.equal(src.kind, 'cloudflare');
  assert.equal(src.limit, 2_000_000);
  assert.equal(src.seed, 0);
});
