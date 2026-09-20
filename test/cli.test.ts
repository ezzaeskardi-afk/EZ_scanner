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
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'src', 'cli', 'main.ts');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

const VLESS =
  'vless://11111111-2222-3333-4444-555555555555@my.example.com:8443?type=ws&security=tls&sni=cdn.example.com&path=%2Fws#MyNode';

async function ezscan(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: root,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
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

test('a per-operator preset is accepted by name and by alias', async () => {
  // The profile these apply is measured in test/operator-profiles.test.ts; here it only has
  // to reach the CLI without an error and produce a runnable plan.
  for (const name of ['irancell', 'mci', 'mobin', 'mtn', 'hamrah', 'mobinnet']) {
    const out = await ezscan(['scan', '--preset', name, '--count', '20', '--dry-run']);
    assert.match(out, /addresses \(ranges/, `--preset ${name} must produce a plan`);
  }
});
