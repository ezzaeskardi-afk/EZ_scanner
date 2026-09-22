/**
 * Gate: every field of `ScanConfig` has to be carried by `sanitizeConfig`.
 *
 * `sanitizeConfig` is the one funnel every surface goes through — CLI flags, the presets, the GUI's
 * `/api/config` and `/api/preset`, a resumed session's overrides — so a field with no branch in it
 * is not merely "unsettable": it is *silently* unsettable. The flag is accepted, `--help` documents
 * it, the preset carries a number, and the run behaves as if none of it were there.
 *
 * Measured, not hypothesised: `betweenTriesMs` and `recoveryPass` were the only two fields without
 * a branch, which meant the retry gap the operator presets were measured with never applied, the
 * recovery pass that finds addresses the line turned away never ran from the CLI or the GUI at all
 * (`recoveryPass` defaults to false), `--retry-gap` was inert, and `--no-recovery` switched off
 * something that was already off. The tests below pin both ends: the rule, statically, so the next
 * field added cannot repeat it, and the two fields themselves, behaviourally.
 *
 * The static half is deliberately conservative in the same spirit as the dead-code gate — a field
 * counts as carried if `patch.<field>` appears anywhere in `validate.ts`, comments included.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPreset, DEFAULT_CONFIG } from '../src/core/types.ts';
import { sanitizeConfig } from '../src/core/validate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const validateSource = readFileSync(join(root, 'src', 'core', 'validate.ts'), 'utf8');

test('no config field is silently dropped on the way in', () => {
  // A word boundary, not a substring: `patch.recoveryPassTypo` used to satisfy a plain
  // `includes()` check — the mutation that proves this gate bites is exactly that rename, and it
  // has to fail here as well as in the behavioural test below.
  const dropped = Object.keys(DEFAULT_CONFIG).filter(
    (key) => !new RegExp(`patch\\.${key}\\b`).test(validateSource),
  );
  assert.deepEqual(
    dropped,
    [],
    `these config fields have no branch in sanitizeConfig, so setting them (from a flag or a ` +
      `preset) is accepted and then ignored: ${dropped.join(', ')}`,
  );
});

test('the retry gap and the recovery pass are carried, bounded, and independent', () => {
  const gap = sanitizeConfig({ betweenTriesMs: 250 }, DEFAULT_CONFIG).config;
  assert.equal(gap.betweenTriesMs, 250);
  assert.equal(
    sanitizeConfig({ betweenTriesMs: 999_999 }, DEFAULT_CONFIG).config.betweenTriesMs,
    10_000,
    'an absurd gap is clamped, not thrown away',
  );
  assert.equal(sanitizeConfig({ betweenTriesMs: -5 }, DEFAULT_CONFIG).config.betweenTriesMs, 0);

  const recovery = sanitizeConfig({ recoveryPass: true }, DEFAULT_CONFIG).config;
  assert.equal(recovery.recoveryPass, true);
  assert.equal(
    recovery.betweenTriesMs,
    DEFAULT_CONFIG.betweenTriesMs,
    'turning one on must not invent a value for the other',
  );
  assert.equal(sanitizeConfig({ recoveryPass: false }, DEFAULT_CONFIG).config.recoveryPass, false);
});

test('an operator preset arrives with the gap and the recovery pass it was measured with', () => {
  for (const name of ['irancell', 'mci', 'mobin']) {
    const preset = applyPreset(name);
    assert.ok(preset, `${name} exists`);
    assert.ok((preset.betweenTriesMs ?? 0) > 0, `${name} spaces its retries`);
    const { config } = sanitizeConfig(preset, DEFAULT_CONFIG);
    assert.equal(config.betweenTriesMs, preset.betweenTriesMs, `${name}'s retry gap must survive sanitizing`);
    assert.equal(config.recoveryPass, true, `${name} must actually run the recovery pass`);
  }
});
