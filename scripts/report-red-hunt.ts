/**
 * Turns a red hunt into a GitHub issue — and a green hunt back into silence.
 *
 * A scheduled hunt runs unattended: its red exit code marks the run red, but nobody is
 * watching at 03:17. This is the step that makes the failure reach a human:
 *
 *   node scripts/report-red-hunt.ts open    # the hunt step failed: open or update the thread
 *   node scripts/report-red-hunt.ts close   # the hunt step passed: close the open thread(s)
 *
 * One thread per red period, not one issue per run: every hunt that goes red while the
 * issue is open comments on it (run link plus the hunt's own per-pass table and verdict),
 * and the first green hunt closes it — `gh issue close --comment` does both in one call.
 * The issue is found by its fixed title, so no state has to be stored anywhere.
 *
 * The workflow drives this by the hunt step's outcome (`if: failure()` / `if: success()`),
 * not by re-deriving redness — the hunt's exit code is the single place that already knows.
 * The body's markdown comes from the hunt's own job summary (copied to the workspace by a
 * `if: failure()` step), so the issue carries exactly what the hunt concluded: the per-pass
 * table and the verdict. The artifact link is the run page, which lists `flake-hunt-results`.
 *
 * Missing inputs or a failing `gh` call are reported but never a non-zero exit: the report
 * is bookkeeping on top of an already-red hunt, and the hunt step's annotation already
 * carries the failure where the fix is looked for. A red *reporter* would just bury it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HuntIssueContext {
  runUrl: string;
  /** The run id, derived from the URL when not given. */
  runId: string;
  /** HEAD of the hunted tree, so the issue names the commit that flaked. */
  sha: string;
}

/** The title is fixed so the next hunt can find the thread by title alone. */
export const ISSUE_TITLE = 'Flake hunt went red';

export function runContext(env: NodeJS.ProcessEnv = process.env): HuntIssueContext {
  const runUrl = env.HUNT_RUN_URL ?? '';
  const last = runUrl.split('/').filter(Boolean).pop();
  return {
    runUrl,
    runId: env.HUNT_RUN_ID || last || 'unknown',
    sha: env.HUNT_SHA ?? '',
  };
}

const RUN_LINK = (context: HuntIssueContext): string =>
  context.runUrl ? `[run ${context.runId}](${context.runUrl})` : `run ${context.runId}`;

const SHA_PART = (context: HuntIssueContext): string =>
  context.sha ? ` on \`${context.sha.slice(0, 7)}\`` : '';

/** The issue body: the hunt's own summary (per-pass table + verdict) under a short intro. */
export function issueBody(context: HuntIssueContext, huntSummary: string): string {
  return [
    `The scheduled hunt went red — ${RUN_LINK(context)}${SHA_PART(context)}.`,
    '',
    'The table below is the hunt\'s own rendering from the job summary; the full evidence (every',
    'pass as measured, plus the verdict) is the `flake-hunt-results` artifact on that run page.',
    '',
    huntSummary.trim(),
    '',
    '---',
    'A race fails *some* passes: fix the test or what it measures. Consistent failures fail every',
    'run: the test is doing its job. The first green hunt closes this issue automatically; every',
    'red hunt while it is open appends its run below.',
  ].join('\n');
}

/** The comment a later red hunt leaves on the open thread. */
export function commentBody(context: HuntIssueContext, huntSummary: string): string {
  return [`Another red hunt — ${RUN_LINK(context)}${SHA_PART(context)}.`, '', huntSummary.trim()].join('\n');
}

/** The comment the first green hunt leaves when it closes the thread. */
export function closeBody(context: HuntIssueContext): string {
  return `The hunt went green — ${RUN_LINK(context)}${SHA_PART(context)}. Closing; reopen on the next red hunt.`;
}

function gh(args: string[], cwd: string): { ok: boolean; output: string } {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** Injectable for tests: a recorder stands in for the real `gh`. */
export type GhRunner = typeof gh;

function ghJson<T>(args: string[], cwd: string): T | null {
  const result = gh(args, cwd);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.output) as T;
  } catch {
    return null;
  }
}

interface FoundIssue {
  number: number;
  state: 'OPEN' | 'CLOSED';
}

/**
 * The newest thread with the fixed title, open or closed. `null` when gh is unavailable,
 * unauthenticated, or no such issue exists — all read as "no thread", the safe direction:
 * a duplicated issue is noise, a lost report is silence.
 */
export function findThread(cwd: string, run: GhRunner = gh): FoundIssue | null {
  const result = run(
    ['issue', 'list', '--state', 'all', '--search', `${ISSUE_TITLE} in:title`, '--json', 'number,state', '--limit', '1'],
    cwd,
  );
  if (!result.ok) return null;
  try {
    return (JSON.parse(result.output) as FoundIssue[])[0] ?? null;
  } catch {
    return null;
  }
}

/** Bodies go through a file: a multi-line `--body` argument mangles newlines on some shells. */
function bodyFile(body: string): { args: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'red-hunt-'));
  const file = join(dir, 'body.md');
  writeFileSync(file, body);
  return {
    args: ['--body-file', file],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function openThread(context: HuntIssueContext, huntSummary: string, cwd: string, run: GhRunner = gh): boolean {
  const thread = findThread(cwd, run);
  if (thread?.state === 'OPEN') {
    const body = bodyFile(commentBody(context, huntSummary));
    const done = run(['issue', 'comment', String(thread.number), ...body.args], cwd);
    body.cleanup();
    console.log(done.ok ? `commented on #${thread.number}` : `gh comment failed: ${done.output}`);
    return done.ok;
  }
  if (thread) {
    // Closed by hand while the hunt stayed red: that state was an operator's decision to mute
    // the signal, so a continuing red period opens a fresh thread instead of reopening it.
    console.log(`#${thread.number} was closed by hand — opening a fresh thread`);
  }
  const body = bodyFile(issueBody(context, huntSummary));
  const created = run(['issue', 'create', '--title', ISSUE_TITLE, ...body.args], cwd);
  body.cleanup();
  console.log(created.ok ? `opened ${created.output}` : `gh create failed: ${created.output}`);
  return created.ok;
}

export function closeThread(context: HuntIssueContext, cwd: string, run: GhRunner = gh): boolean {
  const thread = findThread(cwd, run);
  if (!thread) {
    console.log('no red-hunt thread to close');
    return true;
  }
  if (thread.state === 'CLOSED') {
    console.log(`#${thread.number} is already closed`);
    return true;
  }
  const done = run(['issue', 'close', String(thread.number), '--comment', closeBody(context)], cwd);
  console.log(done.ok ? `closed #${thread.number}` : `gh close failed: ${done.output}`);
  return done.ok;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode !== 'open' && mode !== 'close') {
    console.error('usage: node scripts/report-red-hunt.ts <open|close>');
    return 2;
  }
  const cwd = process.cwd();
  const context = runContext();

  let huntSummary = '';
  const summaryPath = process.env.HUNT_SUMMARY;
  if (summaryPath) {
    try {
      huntSummary = readFileSync(summaryPath, 'utf8');
    } catch (err) {
      // The summary is the body's core, but a missing copy must not turn a red hunt into a
      // red reporter: the issue still opens, with the link and a note about the summary.
      console.error(`hunt summary unreadable (${summaryPath}): ${(err as Error).message}`);
      huntSummary = '_The job summary could not be attached — see the run page and its logs._';
    }
  }

  if (mode === 'open') openThread(context, huntSummary, cwd);
  else closeThread(context, cwd);
  return 0;
}

if (process.argv[1]?.endsWith('report-red-hunt.ts')) {
  process.exit(await main());
}
