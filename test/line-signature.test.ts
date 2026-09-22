/**
 * The line measurement `ezscan doctor` leaves behind, and what the next scan does with it.
 *
 * Two halves, tested separately because they fail differently:
 *
 *   - **the rule** (`adoptPreset`) is pure: an explicit `--preset` wins, `--no-adapt` means the
 *     flags are used exactly as typed, a preset-less measurement applies nothing, and a reading
 *     older than `SIGNATURE_TTL_MS` applies nothing either — the numbers pinned here are the ones
 *     a scan's `--workers`/`--rate` are steered by;
 *   - **the wiring** is spawned: a scan with a remembered signature has to come out of the run
 *     with the preset's own settings in its saved session, not merely with a line printed about it.
 *
 * The one link not covered here is `runDoctor` writing the file: it dials real addresses
 * (1.1.1.1, 8.8.8.8, a Cloudflare edge) and takes no injection point, so the write is verified by
 * running `ezscan doctor` itself rather than in CI. Everything the scan then does with the file
 * is below.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  adoptPreset,
  describeSignatureAge,
  loadLineSignature,
  saveLineSignature,
  SIGNATURE_TTL_MS,
  type StoredSignature,
} from '../src/core/linesig.ts';
import { DEFAULT_CONFIG, PRESETS } from '../src/core/types.ts';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'src', 'cli', 'main.ts');

const HOUR = 60 * 60 * 1000;

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ezscan-linesig-'));
}

/** A measurement as `doctor` would have written it. */
async function seed(
  dataDir: string,
  input: { preset: string | null; reasons?: string[]; measuredAt?: number; ip?: string },
): Promise<void> {
  const written = await saveLineSignature(dataDir, {
    preset: input.preset,
    reasons: input.reasons ?? ['12 sessions at once were turned away (3 black-holed, 0 refused)'],
    ip: input.ip ?? '203.0.113.7',
    ...(input.measuredAt === undefined ? {} : { measuredAt: input.measuredAt }),
  });
  assert.ok(written, 'the fixture signature was written');
}

/**
 * A real scan, small enough to finish on a dead loopback port: nothing answers, so it ends in
 * milliseconds and the config it ran with is in the session it saves.
 */
async function scanWith(dataDir: string, extra: string[] = []): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cli,
      'scan',
      '--no-color',
      '--source',
      'paste',
      '--targets',
      '127.0.0.1',
      '--port',
      '1',
      '--count',
      '1',
      '--print',
      '1',
      ...extra,
    ],
    { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, EZSCAN_DATA_DIR: dataDir } },
  );
  return stdout.replace(/\r/g, '');
}

/** The config the scan actually ran with, read back from the session it saved. */
async function savedConfig(dataDir: string): Promise<Record<string, unknown>> {
  const dir = join(dataDir, 'sessions');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
  assert.equal(files.length, 1, `expected exactly one saved session, found ${files.join(', ') || 'none'}`);
  const snapshot = JSON.parse(await readFile(join(dir, files[0]), 'utf8')) as { config: Record<string, unknown> };
  return snapshot.config;
}

/* ───────────────────────────── the stored record ───────────────────────────── */

test('a measurement survives the round trip through the data folder', async () => {
  const dir = await tempDir();
  try {
    await seed(dir, { preset: 'mci', reasons: ['8 of 12 sessions were reset with nothing else open'] });
    const loaded = await loadLineSignature(dir);
    assert.ok(loaded, 'the record loads back');
    assert.equal(loaded.preset, 'mci');
    assert.deepEqual(loaded.reasons, ['8 of 12 sessions were reset with nothing else open']);
    assert.equal(loaded.ip, '203.0.113.7');
    assert.ok(Math.abs(Date.now() - loaded.measuredAt) < 60_000, 'it is stamped when it was written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file that is not a measurement is read as no measurement', async () => {
  // Every one of these used to be a candidate for steering `--workers`: a scan that cannot trust
  // the file has to behave exactly like a scan with no doctor run behind it.
  const dir = await tempDir();
  try {
    const file = join(dir, 'line-signature.json');
    const cases: Array<[string, string]> = [
      ['not json at all', 'this is not json'],
      ['truncated', '{"version":1,"measuredAt":'],
      ['an empty object', '{}'],
      ['a future version', JSON.stringify({ version: 2, measuredAt: Date.now(), preset: 'mci', reasons: [], ip: 'x' })],
      ['a preset that is not a string', JSON.stringify({ version: 1, measuredAt: Date.now(), preset: 7, reasons: [], ip: 'x' })],
      ['reasons that are not strings', JSON.stringify({ version: 1, measuredAt: Date.now(), preset: 'mci', reasons: [1], ip: 'x' })],
      ['a timestamp that is not a number', JSON.stringify({ version: 1, measuredAt: 'yesterday', preset: 'mci', reasons: [], ip: 'x' })],
    ];
    for (const [label, body] of cases) {
      await writeFile(file, body, 'utf8');
      assert.equal(await loadLineSignature(dir), null, `${label} is not a measurement`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no file yet is no measurement, and writing one never throws', async () => {
  const dir = await tempDir();
  try {
    assert.equal(await loadLineSignature(join(dir, 'nested', 'absent')), null);
    // A data folder that cannot be created (a path under a file) is reported, not thrown: the
    // doctor already fails its "session folder" row in that case, and a scan must still run.
    await writeFile(join(dir, 'a-file'), 'x', 'utf8');
    const written = await saveLineSignature(join(dir, 'a-file', 'nested'), {
      preset: 'mci',
      reasons: [],
      ip: 'x',
    });
    assert.equal(written, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ───────────────────────────── the rule ───────────────────────────── */

const stored = (preset: string | null, measuredAt: number, reasons: string[] = ['the line caps sessions']): StoredSignature => ({
  version: 1,
  measuredAt,
  preset,
  reasons,
  ip: '203.0.113.7',
});

test('an explicit --preset is never second-guessed', () => {
  const now = Date.now();
  const adoption = adoptPreset({ explicit: 'gentle', stored: stored('irancell', now), now });
  assert.equal(adoption.preset, 'gentle');
  assert.equal(adoption.adopted, false);
  assert.equal(adoption.notice, null, 'nothing is said when the user already chose');
});

test('--no-adapt uses the flags exactly as given', () => {
  const now = Date.now();
  const adoption = adoptPreset({ stored: stored('irancell', now), now, disabled: true });
  assert.deepEqual(adoption, { preset: null, adopted: false, notice: null, reasons: [] });
});

test('a fresh measurement is applied, with its evidence and a way out', () => {
  const now = Date.now();
  const adoption = adoptPreset({ stored: stored('irancell', now - 4 * 60_000), now });
  assert.equal(adoption.preset, 'irancell');
  assert.equal(adoption.adopted, true);
  assert.deepEqual(adoption.reasons, ['the line caps sessions']);
  assert.match(adoption.notice ?? '', /doctor measured this line 4 minutes ago/);
  assert.match(adoption.notice ?? '', /--preset irancell/);
});

test('a measurement that named no preset applies nothing and says nothing', () => {
  // "This line showed nothing operator-specific" is a real answer, but repeating it on every scan
  // would be noise — `standard` is already what the scan would have used.
  const now = Date.now();
  const adoption = adoptPreset({ stored: stored(null, now, ['not one probe completed even with an idle line']), now });
  assert.deepEqual(adoption, { preset: null, adopted: false, notice: null, reasons: [] });
});

test('a measurement older than its window is not applied, and says why', () => {
  const now = Date.now();
  // The boundary is inclusive, so the reading is trusted for exactly its window and not a
  // millisecond longer.
  const atBoundary = adoptPreset({ stored: stored('mci', now - SIGNATURE_TTL_MS), now });
  assert.equal(atBoundary.preset, 'mci', 'the window is inclusive at its edge');
  const past = adoptPreset({ stored: stored('mci', now - SIGNATURE_TTL_MS - 1), now });
  assert.equal(past.preset, null);
  assert.equal(past.adopted, false);
  assert.match(past.notice ?? '', /too old to apply/);
  assert.match(past.notice ?? '', /ezscan doctor/, 'it names the command that refreshes it');
  assert.match(past.notice ?? '', /--preset mci/, 'and the answer it is withholding');
});

test('a clock that ran backwards is not read as an expired measurement', () => {
  const now = Date.now();
  const adoption = adoptPreset({ stored: stored('mci', now + 5 * 60_000), now });
  assert.equal(adoption.preset, 'mci');
});

test('nothing stored means nothing said', () => {
  const adoption = adoptPreset({ stored: null, now: Date.now() });
  assert.deepEqual(adoption, { preset: null, adopted: false, notice: null, reasons: [] });
});

test('ages read the way a person says them', () => {
  const now = Date.now();
  assert.equal(describeSignatureAge(now - 20_000, now), 'moments ago');
  assert.equal(describeSignatureAge(now - 60_000, now), '1 minute ago');
  assert.equal(describeSignatureAge(now - 42 * 60_000, now), '42 minutes ago');
  assert.equal(describeSignatureAge(now - 60 * 60_000, now), '1 hour ago');
  assert.equal(describeSignatureAge(now - 11 * HOUR, now), '11 hours ago');
  assert.equal(describeSignatureAge(now - 3 * 24 * HOUR, now), '3 days ago');
});

/* ───────────────────────────── the wiring ───────────────────────────── */

test('a scan applies the remembered preset, not just a line about it', async () => {
  const dir = await tempDir();
  try {
    await seed(dir, { preset: 'irancell' });
    const out = await scanWith(dir);
    assert.match(out, /doctor measured this line moments ago and it needs --preset irancell/);
    assert.match(out, /--no-adapt scans with exactly the flags you gave/);
    const config = await savedConfig(dir);
    const preset = PRESETS.irancell;
    assert.equal(config.workers, preset.workers, 'the scan ran with the measured preset workers');
    assert.equal(config.rateLimitPerSec, preset.rateLimitPerSec);
    assert.equal(config.betweenTriesMs, preset.betweenTriesMs);
    assert.notEqual(config.workers, DEFAULT_CONFIG.workers, 'and not with the default the flags would have given');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--no-adapt runs the flags as typed even with a fresh measurement on file', async () => {
  const dir = await tempDir();
  try {
    await seed(dir, { preset: 'irancell' });
    const out = await scanWith(dir, ['--no-adapt']);
    assert.doesNotMatch(out, /doctor measured this line/);
    const config = await savedConfig(dir);
    assert.equal(config.workers, DEFAULT_CONFIG.workers);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stale measurement is reported and not applied', async () => {
  const dir = await tempDir();
  try {
    await seed(dir, { preset: 'irancell', measuredAt: Date.now() - 30 * HOUR });
    const out = await scanWith(dir);
    assert.match(out, /line signature is from 1 day ago|line signature is from 30 hours ago/);
    assert.match(out, /too old to apply/);
    const config = await savedConfig(dir);
    assert.equal(config.workers, DEFAULT_CONFIG.workers, 'a measurement from yesterday does not steer today');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit --preset beats the measurement without a word about it', async () => {
  const dir = await tempDir();
  try {
    await seed(dir, { preset: 'irancell' });
    const out = await scanWith(dir, ['--preset', 'gentle']);
    assert.doesNotMatch(out, /doctor measured this line/);
    const config = await savedConfig(dir);
    assert.equal(config.workers, PRESETS.gentle.workers);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hand-edited measurement file does not stop a scan', async () => {
  const dir = await tempDir();
  try {
    await seed(dir, { preset: 'irancell' });
    await writeFile(join(dir, 'line-signature.json'), '"mci"', 'utf8');
    const out = await scanWith(dir);
    assert.doesNotMatch(out, /doctor measured this line/);
    assert.equal((await savedConfig(dir)).workers, DEFAULT_CONFIG.workers);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
