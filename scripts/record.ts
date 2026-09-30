/**
 * The A/B record grows itself.
 *
 * Every Sunday the heavy hunt leaves its receipt in an artifact; the record in the README
 * grows one sentence at a time, and until now a human moved it. This is that move:
 *
 *   npm run record
 *
 * Reads the newest heavy hunt through the receipt's own pipeline (no second parser), renders
 * the record's next sentence from the artifact's numbers, and appends it to the README's
 * record paragraph — once per date. A date already in the record is skipped (exit 0, nothing
 * written), so re-running after a re-dispatch cannot duplicate a row, and the commit is left
 * for the caller: the record is evidence, and evidence names its author.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestHeavyReceipt, type Receipt } from './heavy-receipt.ts';
import type { HeavyHunt } from './heavy-receipt.ts';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(root, 'README.md');
const ANCHOR = '`npm run hunt-receipt` away from being read.';

/** The record's sentence for one receipt — the same shape the 2026-09-27 row set. */
export function recordSentence(hunt: HeavyHunt, receipt: Receipt): string {
  const day = hunt.createdAt.slice(0, 10);
  const verdict = receipt.flaked < 0 || receipt.consistent < 0
    ? 'the verdict line is missing from the artifact'
    : `${receipt.flaked} flake(s) and ${receipt.consistent} break(s) in the verdict`;
  const health = receipt.timedOut
    ? `${receipt.ok}/${receipt.passes} clean plus ${receipt.timedOut} timed out`
    : `${receipt.ok} for ${receipt.passes}`;
  return `The next scheduled firing (${day}, commit \`${hunt.headSha.slice(0, 7)}\`) came back ${health} —\n${receipt.totalSeconds.toFixed(1)} seconds of loaded scanning, a ${receipt.meanSeconds.toFixed(1)}-second mean per pass,\n${verdict}, and the \`flake-hunt-results\` artifact attached.`;
}

/** The README with at most one new sentence appended, or null when the date is already recorded. */
export function appendToRecord(readme: string, sentence: string, day: string): string | null {
  if (readme.includes(`(${day},`)) return null;
  if (!readme.includes(ANCHOR)) throw new Error('the README record paragraph has drifted — ANCHOR text not found');
  return readme.replace(ANCHOR, `${ANCHOR}\n${sentence}`);
}

if (process.argv[1]?.endsWith('record.ts')) {
  try {
    const { hunt, receipt } = await latestHeavyReceipt((args) => {
      const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
      return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
    });
    const day = hunt.createdAt.slice(0, 10);
    const readme = readFileSync(README, 'utf8');
    const updated = appendToRecord(readme, recordSentence(hunt, receipt), day);
    if (updated === null) {
      console.log(`${day} is already in the A/B record — nothing to do.`);
      process.exit(0);
    }
    writeFileSync(README, updated);
    console.log(recordSentence(hunt, receipt));
    console.log(`\nappended to README.md — review, then commit as: docs: the heavy hunt's ${day} receipt enters the A/B record`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
