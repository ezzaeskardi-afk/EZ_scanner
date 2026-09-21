/**
 * CLI contract tests.
 *
 * The CLI is the one entry point that cannot be unit-tested by import (it runs on load),
 * so these spawn the real thing. Everything below stays offline: `--dry-run` expands a
 * source without probing anything and `config` only parses a link.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openBrowser } from '../src/cli/openbrowser.ts';
import { startHostileLine } from './helpers/hostile-line.ts';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'src', 'cli', 'main.ts');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

const VLESS =
  'vless://11111111-2222-3333-4444-555555555555@my.example.com:8443?type=ws&security=tls&sni=cdn.example.com&path=%2Fws#MyNode';

async function ezscan(args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: root,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return stdout.replace(/\r/g, '');
}

test('--version prints the package version', async () => {
  assert.equal((await ezscan(['--version'])).trim(), pkg.version);
});

test('scan --dry-run expands a source without touching the network', async () => {
  const out = await ezscan(['scan', '--dry-run', '--count', '25', '--seed', '7']);
  assert.match(out, /source: cloudflare → 25 addresses/);
  assert.match(out, /sample: /);
});

test('the command `ezscan config` recommends scans the ranges, not just the config address', async () => {
  const out = await ezscan(['config', VLESS]);
  const recommended = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('ezscan scan'));
  assert.ok(recommended, 'a scan command is recommended');
  // `--source config` scans the config's own server address only, and a count is inert
  // there, so recommending it with `--count 3000` sent people to a one-address scan.
  assert.doesNotMatch(recommended, /--source config/);
  assert.match(recommended, /--count 3000/);
  assert.match(recommended, /--sni cdn\.example\.com/);
  assert.match(recommended, /--port 8443/);
  // The config's own address is still offered, but named as such.
  assert.match(out, /scan the config's own address instead/);
});

test('an unknown preset lists the real ones', async () => {
  await assert.rejects(
    () => ezscan(['scan', '--preset', 'nope', '--dry-run']),
    (err: unknown) => {
      const message = String((err as { stderr?: string }).stderr ?? '');
      assert.match(message, /unknown preset "nope"/);
      for (const name of ['gentle', 'standard', 'fast', 'strict', 'iran', 'irancell', 'mci', 'mobin']) {
        assert.match(message, new RegExp(name), `the list must mention ${name}`);
      }
      return true;
    },
  );
});

test('every option the CLI reads as a boolean is registered as one', () => {
  // An unregistered name is parsed as "takes a value", so it eats the token after it and the
  // command silently loses an argument. That is how `ezscan resume --no-speed a1b2c3d4` printed
  // the usage text instead of resuming: the session id was consumed as the flag's value. This is
  // a static check on purpose — `main.ts` runs on import, so the list cannot be imported here.
  const source = readFileSync(cli, 'utf8');
  const block = /const BOOL_FLAGS = new Set\(\[([\s\S]*?)\]\);(?:\n)/.exec(source);
  assert.ok(block, 'BOOL_FLAGS must stay a single literal so it can be checked');
  const registered = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const read = [...new Set([...source.matchAll(/flags\.has\('([^']+)'\)/g)].map((m) => m[1]))].sort();
  const missing = read.filter((name) => !registered.has(name));
  assert.deepEqual(
    missing,
    [],
    `read with flags.has() but not in BOOL_FLAGS (they would swallow the next argument): ${missing.join(', ')}`,
  );
  for (const flag of ['all', 'no-speed']) {
    assert.match(source, new RegExp(`--${flag}\\b`), `--${flag} must be documented in the usage text`);
  }
});

test('a boolean flag does not eat the argument after it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ez-scanner-cli-'));
  try {
    await assert.rejects(
      () => ezscan(['resume', '--no-speed', 'a1b2c3d4'], { EZSCAN_DATA_DIR: dataDir }),
      (err: unknown) => {
        const stderr = String((err as { stderr?: string }).stderr ?? '');
        assert.doesNotMatch(stderr, /usage: ezscan resume/, 'the id must survive the flag');
        assert.match(stderr, /session "a1b2c3d4" not found/, 'and reach the loader');
        return true;
      },
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a machine without a browser helper does not take the CLI down', async () => {
  // The helper is spawned detached, so a missing one fails *asynchronously*: `spawn` emits an
  // `error` event, and an unhandled `error` event is thrown. That killed `ezscan gui` a tick
  // after it printed the URL — the server was up, and the process was gone. A headless Linux box
  // has no xdg-open, which is exactly where the GUI is most useful (a remote machine).
  openBrowser('http://127.0.0.1:1/?token=x', { command: 'definitely-not-a-real-browser-helper', args: ['http://127.0.0.1:1/'] });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(true, 'reaching this line means the spawn failure was contained');
});

test('--no-speed skips the speed phase on a scan, not only on a resume', async () => {
  // docs/USAGE.md documents `ezscan scan --preset mobin --count 5000 --no-speed …` as the way to
  // leave the speed phase out on a line with a broken PMTU, and the flag only reached `resume`:
  // a scan ran the phase anyway. The fake line keeps this offline — the speed URL is its own.
  const dataDir = await mkdtemp(join(tmpdir(), 'ez-scanner-cli-'));
  const line = await startHostileLine({ sessionLimit: 16, baseDelayMs: 2 });
  const args = [
    'scan', '--source', 'paste', '--targets', `127.0.0.1:${line.port}`,
    '--mode', 'tcp', '--tries', '1', '--timeout', '2000', '--workers', '2',
    '--speed', '--speed-bytes', '64000',
    '--speed-url', `https://127.0.0.1:${line.port}/__down?bytes=%BYTES%`,
    '--speed-sni', 'hostile.line',
  ];
  try {
    const withSpeed = await ezscan(args, { EZSCAN_DATA_DIR: dataDir, NO_COLOR: '1' });
    const skipped = await ezscan([...args, '--no-speed'], { EZSCAN_DATA_DIR: dataDir, NO_COLOR: '1' });
    assert.match(withSpeed, /speed-testing top 1 addresses/, 'the phase runs by default');
    assert.doesNotMatch(skipped, /speed-testing/, 'and --no-speed leaves it out');
  } finally {
    await line.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a per-operator preset is accepted by name and by alias', async () => {
  // The profile these apply is measured in test/operator-profiles.test.ts; here it only has
  // to reach the CLI without an error and produce a runnable plan.
  for (const name of ['irancell', 'mci', 'mobin', 'mtn', 'hamrah', 'mobinnet']) {
    const out = await ezscan(['scan', '--preset', name, '--count', '20', '--dry-run']);
    assert.match(out, /addresses \(ranges/, `--preset ${name} must produce a plan`);
  }
});
