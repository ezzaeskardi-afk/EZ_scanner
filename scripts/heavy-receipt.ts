/**
 * One command for the Sunday heavy hunt's receipt.
 *
 * The A/B record in the README grows one receipt at a time: a Sunday night fires the
 * thirty-pass, load-3 hunt over the full five-file integration set, and the run leaves its
 * own evidence artifact. This reads the newest heavy hunt and prints the receipt as the
 * record's next sentence — parameters, per-pass health, verdict, artifact, commit — without
 * anyone opening a browser:
 *
 *   npm run heavy-receipt
 *
 * Exit code 0 only on a completed, green heavy hunt; a red one still prints the full
 * receipt (that is exactly when it is needed) and exits non-zero. Best-effort `gh` with one
 * retry on the known transient TLS failure.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'ezzaeskardi-afk';
const REPO = 'EZ_scanner';
const NIGHTLY_SECONDS = 15 * 60;

export interface HeavyHunt {
  id: number;
  createdAt: string;
  updatedAt: string;
  conclusion: string;
  headSha: string;
}

/** Duration in seconds; NaN-safe — a run whose updated_at never arrived reads as unknown. */
export function durationSeconds(hunt: Pick<HeavyHunt, 'createdAt' | 'updatedAt'>): number {
  const ms = new Date(hunt.updatedAt).getTime() - new Date(hunt.createdAt).getTime();
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

/** The heavy net is the long scheduled run: the nightly floor finishes in ~6 minutes. */
export function isHeavy(hunt: HeavyHunt): boolean {
  const seconds = durationSeconds(hunt);
  return Number.isFinite(seconds) && seconds >= NIGHTLY_SECONDS;
}

export function artifactUrl(runId: number): string {
  return `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}#artifact`;
}

/** The verdict's one-line shape, from the artifact's JSON — the receipt reads evidence, not memory. */
export interface Receipt {
  startedAt: string;
  passes: number;
  ok: number;
  timedOut: number;
  totalSeconds: number;
  meanSeconds: number;
  flaked: number;
  consistent: number;
  files: string[];
}

/** The parsed artifact body, checked for the fields the receipt needs. */
export function parseResults(body: string): Receipt {
  const raw = JSON.parse(body) as {
    startedAt?: string; passes?: Array<{ timedOut?: boolean; failed?: unknown[]; seconds?: number }>;
    verdict?: { flaked?: unknown[]; consistent?: unknown[]; timedOut?: number };
    files?: string[];
  };
  const passes = raw.passes ?? [];
  const seconds = passes.reduce((sum, pass) => sum + (pass.seconds ?? 0), 0);
  return {
    startedAt: raw.startedAt ?? '?',
    passes: passes.length,
    ok: passes.filter((pass) => !pass.timedOut && (pass.failed ?? []).length === 0).length,
    timedOut: passes.filter((pass) => pass.timedOut).length,
    totalSeconds: seconds,
    meanSeconds: passes.length ? seconds / passes.length : NaN,
    flaked: raw.verdict?.flaked?.length ?? -1,
    consistent: raw.verdict?.consistent?.length ?? -1,
    files: raw.files ?? [],
  };
}

/** The record's next sentence, built only from the artifact's own numbers. */
export function renderReceipt(hunt: HeavyHunt, receipt: Receipt): string {
  const day = hunt.createdAt.slice(0, 10);
  const verdict = receipt.flaked < 0 || receipt.consistent < 0
    ? 'the verdict line is missing from the artifact'
    : `${receipt.flaked} flake(s), ${receipt.consistent} break(s) in the verdict`;
  const health = receipt.timedOut
    ? `${receipt.ok}/${receipt.passes} clean plus ${receipt.timedOut} timed out`
    : `${receipt.ok} for ${receipt.passes}`;
  return [
    `Heavy hunt receipt — ${day}, commit \`${hunt.headSha.slice(0, 7)}\`:`,
    `  ${health} · load 3 · ${receipt.files.length} file(s) · ${receipt.totalSeconds.toFixed(1)}s total, ${receipt.meanSeconds.toFixed(1)}s mean/pass`,
    `  ${verdict} · artifact: ${artifactUrl(hunt.id)}`,
  ].join('\n');
}

type Gh = (args: string[]) => { ok: boolean; output: string };

function defaultGh(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function withRetry(gh: Gh, args: string[]): { ok: boolean; output: string } {
  const first = gh(args);
  return first.ok ? first : gh(args);
}

/**
 * Finds the newest heavy hunt, downloads its artifact and parses the receipt. Shared by the
 * receipt's own CLI and by `npm run record`, which writes the A/B row into the README.
 */
export async function latestHeavyReceipt(gh: Gh): Promise<{ hunt: HeavyHunt; receipt: Receipt }> {
  const runs = withRetry(gh, ['api', `repos/${OWNER}/${REPO}/actions/runs?event=schedule&per_page=40`, '--jq', '.workflow_runs']);
  if (!runs.ok) throw new Error(`gh could not list runs: ${runs.output}`);
  const hunts = (JSON.parse(runs.output) as Array<Record<string, unknown>>)
    .map((run) => ({
      id: run.id as number,
      createdAt: run.created_at as string,
      updatedAt: run.updated_at as string,
      conclusion: (run.conclusion as string) ?? '',
      headSha: (run.head_sha as string) ?? '',
    }));
  const heavy = hunts.filter(isHeavy).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!heavy) throw new Error('no heavy hunt in the recent scheduled runs — has Sunday come yet?');

  const download = withRetry(gh, ['api', `repos/${OWNER}/${REPO}/actions/runs/${heavy.id}/artifacts`, '--jq', '.artifacts[0].name']);
  const name = download.ok ? download.output : '';
  if (!name) throw new Error(`no artifact on run ${heavy.id}`);
  const tmp = spawnSync(process.execPath, ['-e', `
    const { mkdtempSync } = require('node:fs');
    process.stdout.write(mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'heavy-')));
  `], { encoding: 'utf8' });
  const dir = tmp.stdout.trim();
  const got = withRetry(gh, ['run', 'download', String(heavy.id), '-n', name, '-D', dir]);
  if (!got.ok) throw new Error(`gh could not download ${name}: ${got.output}`);
  const body = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const file = fs.readdirSync(process.argv[1]).find((f) => f.endsWith('.json'));
    process.stdout.write(fs.readFileSync(require('node:path').join(process.argv[1], file), 'utf8'));
  `, dir], { encoding: 'utf8' });
  if (!body.stdout) throw new Error(`artifact ${name} carried no readable JSON: ${body.stderr}`);
  return { hunt: heavy, receipt: parseResults(body.stdout) };
}

if (process.argv[1]?.endsWith('heavy-receipt.ts')) {
  try {
    const { hunt, receipt } = await latestHeavyReceipt(defaultGh);
    console.log(renderReceipt(hunt, receipt));
    if (hunt.conclusion !== 'success' || receipt.timedOut) {
      console.error('the heavy hunt is RED — this receipt is the triage sheet');
      process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
