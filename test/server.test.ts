import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { connect } from 'node:net';
import { createEzServer, type EzServer } from '../src/server/server.ts';
import { startFakeEdge, type FakeEdge } from './helpers/localnet.ts';

let server: EzServer;
let edge: FakeEdge;
let dataDir: string;
let base: string;

before(async () => {
  edge = await startFakeEdge({ status: 200 });
  dataDir = await mkdtemp(join(tmpdir(), 'ez-server-test-'));
  server = await createEzServer({ dataDir, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  await edge.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, token = server.token) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ez-token': token },
    body: JSON.stringify(body),
  });

/* eslint-disable @typescript-eslint/no-explicit-any */
const postJson = async <T = any>(path: string, body: unknown): Promise<T> => (await post(path, body)).json() as Promise<T>;
const getJson = async <T = any>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;

test('serves the GUI shell with the per-run token injected', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('EZ Scanner'));
  assert.ok(html.includes(server.token), 'token injected into the page');
  assert.ok(!html.includes('__EZ_TOKEN__'));
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  const missing = await fetch(`${base}/nope.js`);
  assert.equal(missing.status, 404);
});

test('static assets are gzip-compressed and versioned ones are cacheable', async () => {
  const identity = await fetch(`${base}/styles.css`, { headers: { 'accept-encoding': 'identity' } });
  const raw = await identity.text();
  assert.equal(identity.headers.get('content-encoding'), null);
  assert.equal(identity.headers.get('cache-control'), 'no-store');

  const gzipped = await fetch(`${base}/styles.css`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gzipped.headers.get('content-encoding'), 'gzip');
  assert.match(gzipped.headers.get('vary') ?? '', /accept-encoding/i);
  assert.ok(
    Number(gzipped.headers.get('content-length')) < Number(identity.headers.get('content-length')),
    'compressed length should be smaller',
  );
  assert.equal(await gzipped.text(), raw, 'compression must not change the body');

  // The vendored bundle is the reason this exists: 3.5 MB -> ~1 MB.
  const bundle = await fetch(`${base}/vendor/openui/openui-bundle.min.js?v=0.1.4`);
  assert.equal(bundle.headers.get('content-encoding'), 'gzip');
  assert.match(bundle.headers.get('cache-control') ?? '', /immutable/);
  assert.ok(Number(bundle.headers.get('content-length')) < 1_500_000);
});

test('serves the OpenUI report page and its vendored renderer offline', async () => {
  const page = await fetch(`${base}/report.html`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('/vendor/openui/openui-bundle.min.js'), 'renderer is loaded from our own origin');
  assert.ok(!/https?:\/\/(cdn|unpkg)/.test(html), 'no CDN dependencies');

  const bundle = await fetch(`${base}/vendor/openui/openui-bundle.min.js`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
  const styles = await fetch(`${base}/vendor/openui/openui-styles.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get('content-type') ?? '', /text\/css/);
});

test('the OpenUI report endpoint renders the current scan as OpenUI Lang', async () => {
  const idle = await getJson<{ ok: boolean; code: string; counts: { addresses: number } }>('/api/report/openui');
  assert.equal(idle.ok, true);
  assert.match(idle.code, /^root = Card\(\[/);
  assert.match(idle.code, /Callout\("neutral"/);

  const capped = (await fetch(`${base}/api/report/openui?top=5`).then((r) => r.json())) as { code: string };
  assert.ok(capped.code.includes('EZ Scanner'));
  // The report is English-only: no Persian/Arabic script reaches the renderer.
  assert.ok(!/[\u0600-\u06ff]/.test(capped.code), 'report must not carry non-English text');

  const download = await fetch(`${base}/api/report/openui?download=1`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
  assert.match(await download.text(), /^root = Card\(\[/);
});

test('mutating endpoints require the token and same-origin', async () => {
  const noToken = await fetch(`${base}/api/scan/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noToken.status, 403);
  const wrongToken = await post('/api/scan/pause', {}, 'not-the-token');
  assert.equal(wrongToken.status, 403);
  const crossOrigin = await fetch(`${base}/api/state`, { headers: { Origin: 'http://evil.example' } });
  assert.equal(crossOrigin.status, 403);
  // `fetch` will not let us spoof Host, so this one goes over a raw socket
  // (DNS-rebinding style request).
  const spoofed = await rawRequest(server.port, 'GET /api/state HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n');
  assert.match(spoofed, /^HTTP\/1\.1 403/);
});

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

test('state, preview and config parsing endpoints answer', async () => {
  const state = await getJson('/api/state');
  assert.equal(state.ok, true);
  assert.equal(state.state, 'idle');
  assert.ok(state.config && state.source);
  assert.ok(Array.isArray(state.sessions));

  const preview = await postJson('/api/source/preview', { source: { kind: 'cloudflare', limit: 20, seed: 2 } });
  assert.equal(preview.count, 20);
  assert.equal(preview.sample.length, 20);

  const pasted = await postJson('/api/source/preview', { source: { kind: 'paste', text: '1.2.3.4\n104.16.0.0/30', limit: 0 } });
  assert.equal(pasted.count, 5);

  const parsed = await postJson('/api/config/parse', {
    config: 'vless://uuid@my.example.com:8443?type=ws&security=tls&sni=s.example.com#n',
  });
  assert.equal(parsed.parsed.sni, 's.example.com');
  assert.equal(parsed.parsed.port, 8443);

  const broken = await post('/api/config/parse', { config: 'nonsense' });
  assert.equal(broken.status, 400);
});

test('presets configure the scanner and surface warnings', async () => {
  const res = await postJson('/api/preset', { name: 'strict' });
  assert.equal(res.config.requireWs, true);
  assert.equal(res.config.stabilityMs, 1500);
  assert.ok(res.warnings.length >= 1, 'strict gates warn');
  const back = await postJson('/api/preset', { name: 'gentle' });
  assert.equal(back.config.requireWs, false);
  const unknown = await post('/api/preset', { name: 'nope' });
  assert.equal(unknown.status, 400);
});

test('a scan can be started, streamed over SSE and exported', async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const sse = await fetch(`${base}/api/events`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
  assert.equal(sse.status, 200);
  const reader = sse.body!.getReader();
  const pump = (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
      }
    } catch {
      /* aborted below */
    }
  })();

  const start = await postJson('/api/scan/start', {
    mode: 'targets',
    targets: [`127.0.0.1:${edge.port}`],
    config: { mode: 'http', sni: '', port: edge.port, tries: 1, minSuccesses: 1, workers: 2, timeoutMs: 3000, minScore: 0 },
  });
  assert.equal(start.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  controller.abort();
  await pump;

  const joined = events.join('');
  assert.ok(joined.includes('event: progress'), 'progress events streamed');
  assert.ok(joined.includes('event: results'), 'results streamed');

  const state = await getJson('/api/state?limit=10');
  assert.equal(state.state, 'done');
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].healthy, true);

  const csv = await post('/api/export', { format: 'csv' });
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(String(csv.headers.get('content-disposition')), /attachment; filename="ez-scanner-.*\.csv"/);
  assert.ok((await csv.text()).includes('127.0.0.1'));

  const inline = await postJson('/api/export/inline', {
    format: 'links',
    template: 'vless://uuid@host:443?security=tls&sni=s.example',
    labelPrefix: 'EZ',
  });
  assert.equal(inline.count, 1);
  assert.match(inline.text, /^vless:\/\/uuid@127\.0\.0\.1:443/);

  const inlineXlsx = await postJson('/api/export/inline', { format: 'xlsx' });
  assert.equal(inlineXlsx.binary, true);
  assert.ok(Buffer.from(inlineXlsx.text, 'base64').subarray(0, 2).toString() === 'PK');

  const badFormat = await post('/api/export/inline', { format: 'links' });
  assert.equal(badFormat.status, 500, 'links without a template is an error, not a crash');
});

test('sessions can be saved, listed, exported and deleted', async () => {
  const saved = await postJson('/api/scan/save', {});
  assert.equal(saved.ok, true);
  assert.ok(saved.sessions.length >= 1);
  const id = saved.sessions[0].id;

  const listed = await getJson('/api/sessions');
  assert.ok(listed.sessions.some((s: { id: string }) => s.id === id));

  const exported = await post('/api/sessions/export', { id });
  assert.equal(exported.status, 200);
  const snapshot = JSON.parse(await exported.text());
  assert.ok(Array.isArray(snapshot.targets));

  const imported = await postJson('/api/sessions/import', { raw: JSON.stringify({ ...snapshot, id: 'imported-1', label: 'imported' }) });
  assert.equal(imported.ok, true);
  assert.ok(imported.sessions.some((s: { id: string }) => s.id === 'imported-1'));

  const badImport = await post('/api/sessions/import', { raw: '{"nope":1}' });
  assert.equal(badImport.status, 400);

  const deleted = await postJson('/api/sessions/delete', { id: 'imported-1' });
  assert.ok(!deleted.sessions.some((s: { id: string }) => s.id === 'imported-1'));
});

test('the session endpoints take an id, never a path', async () => {
  // `loadSnapshot` also accepts a path on purpose (`ezscan resume ./file.json`), so an id straight
  // from a request body reached the filesystem as one: with the per-run token, `sessions/export`
  // read any file the server could open and `sessions/delete` unlinked any `.json` next to the data
  // folder — and an imported snapshot's own `id` chose its filename. Through the API an id is an id.
  for (const path of ['/api/sessions/load', '/api/sessions/export', '/api/sessions/delete']) {
    const res = await post(path, { id: '../../../etc/passwd' });
    assert.equal(res.status, 400, `${path} must refuse a path`);
  }
  const missing = await post('/api/sessions/load', {});
  assert.equal(missing.status, 400);

  const saved = await postJson('/api/scan/save', {});
  const id = saved.sessions[0].id;
  assert.equal((await post('/api/sessions/load', { id })).status, 200, 'a real id still loads');

  const snapshot = JSON.parse(await (await post('/api/sessions/export', { id })).text()) as { targets: string[] };
  const imported = await postJson('/api/sessions/import', { raw: JSON.stringify({ ...snapshot, id: '../../escape' }) });
  assert.match(imported.id, /^[0-9a-f-]{36}$/, 'an imported snapshot cannot name a file outside the folder');
  const resume = await post('/api/scan/start', { mode: 'resume', resumeId: '../../escape' });
  assert.equal(resume.status, 400);
});

test('a session id cannot name a windows device', async () => {
  // `\w` matches `CON`, and Windows resolves `CON.json` to the console device whatever the
  // extension hangs off it — so the id guard has to reject the reserved names itself, not only the
  // separators. It is the same guard the import path uses to choose a filename.
  for (const id of ['CON', 'nul', 'LPT1', 'con.json', 'COM9']) {
    assert.equal((await post('/api/sessions/delete', { id })).status, 400, `${id} must be refused`);
  }
});

test('a resume runs with the settings on screen, not the ones the session was saved with', async () => {
  // `restore()` replaces the scanner's config with the snapshot's, so the config this endpoint had
  // just validated, answered `ok` for and broadcast back into the form was silently dropped: the
  // user edited a setting, pressed Resume, and the run used the session's old value. The CLI closed
  // this shape in 1.7.1 by treating its flags as a patch over the session's config; here the posted
  // config *is* the form the user is looking at, so it is what the resumed run has to use.
  const saved = await postJson('/api/scan/save', {});
  const id = saved.sessions[0].id;
  const started = await postJson('/api/scan/start', {
    mode: 'resume',
    resumeId: id,
    config: { sni: 'typed-in-the-form.example', workers: 3 },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  for (let i = 0; i < 60; i++) {
    if ((await getJson<{ state: string }>('/api/state')).state === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = await getJson<{ config: { sni: string; workers: number } }>('/api/state');
  assert.equal(state.config.sni, 'typed-in-the-form.example', 'the resumed run uses the settings on screen');
  assert.equal(state.config.workers, 3);
});

test('a resume that carries no settings keeps the session\'s own', async () => {
  // The other half of the same rule. `{mode:'resume', resumeId}` with no `config` is a flagless
  // `ezscan resume <id>`, and the session's own settings are the only honest answer — the endpoint
  // must not silently swap in whatever config this server happens to be holding. Applying a config
  // that was never posted is the same silent replacement the test above is about, in the other
  // direction, and it is what the override did to every request that did not send the GUI form.
  // A session is saved with one set of settings, and the server's own config is then moved
  // somewhere else — so the two are told apart by the run that follows.
  await postJson('/api/config', { config: { sni: 'the-sessions-own.example', workers: 3 } });
  const saved = await postJson('/api/scan/save', {});
  const id = saved.sessions[0].id;
  await postJson('/api/config', { config: { sni: 'somewhere-else.example', workers: 7 } });
  assert.equal((await getJson<{ config: { sni: string } }>('/api/state')).config.sni, 'somewhere-else.example');

  const started = await postJson('/api/scan/start', { mode: 'resume', resumeId: id });
  assert.equal(started.ok, true, JSON.stringify(started));
  for (let i = 0; i < 60; i++) {
    if ((await getJson<{ state: string }>('/api/state')).state === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = await getJson<{ config: { sni: string; workers: number } }>('/api/state');
  assert.equal(state.config.sni, 'the-sessions-own.example', "the session's own settings, not the server's");
  assert.equal(state.config.workers, 3);
});

test('retest and summary endpoints work on the collected results', async () => {
  const retest = await postJson('/api/retest', { keys: [`127.0.0.1:${edge.port}`], mode: 'probe' });
  assert.equal(retest.updated, 1);
  const summary = await getJson('/api/summary');
  assert.match(summary.summary, /1 healthy/);
});

test('unknown endpoints and oversized bodies are rejected cleanly', async () => {
  const unknown = await fetch(`${base}/api/nope`);
  assert.equal(unknown.status, 404);
  const badJson = await fetch(`${base}/api/source/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ez-token': server.token },
    body: '{not json',
  });
  assert.equal(badJson.status, 500);
});

test('a second scan cannot start while one is running', async () => {
  const long = Array.from({ length: 200 }, () => `127.0.0.1:${edge.port}`);
  const first = await postJson('/api/scan/start', {
    mode: 'targets',
    targets: long,
    config: { mode: 'http', sni: '', port: edge.port, tries: 1, minSuccesses: 1, workers: 2, timeoutMs: 3000, minDelayMs: 20 },
  });
  assert.equal(first.ok, true);
  const second = await post('/api/scan/start', { mode: 'targets', targets: ['127.0.0.1:1'] });
  assert.equal(second.status, 409);
  // A retest rewrites rows and re-scores the batch, so it is a writer like a scan start: it used to
  // run in the middle of a live scan and re-probe a row the speed phase was writing to.
  const retestWhileRunning = await post('/api/retest', { keys: [`127.0.0.1:${edge.port}`], mode: 'probe' });
  assert.equal(retestWhileRunning.status, 409);
  await post('/api/scan/pause', {});
  const paused = await getJson('/api/state');
  assert.equal(paused.state, 'paused');
  await post('/api/scan/resume', {});
  await post('/api/scan/stop', {});
  await new Promise((resolve) => setTimeout(resolve, 300));
});
