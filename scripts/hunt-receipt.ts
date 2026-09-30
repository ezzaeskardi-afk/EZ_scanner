/**
 * One command for the week's hunt receipt.
 *
 * The scheduled hunts already keep their own records — a red night opens a "Flake hunt went
 * red" issue carrying the hunt's per-pass table and verdict, every run leaves a results
 * artifact, and the run pages hold the logs — but the records are scattered across days. When
 * the question is "what did the hunts say this week?", the answer wants one page. This is
 * that page, read-only against `gh`:
 *
 *   npm run hunt-receipt           # the trailing 7 days
 *   npm run hunt-receipt -- 14     # a longer window
 *
 * Scheduled runs only: dispatches and release-gate hunts are hand-watched by construction,
 * so counting them here would overstate what the *net* saw. Reds are reported the way the
 * repo reports everything — with the verdict table (embedded in the issue thread by the
 * red-hunt reporter) and the artifact link, not a bare "it failed".
 *
 * `gh` is read best-effort and retried once on the known transient TLS failure; a run the
 * API cannot describe appears as "details unavailable" rather than sinking the receipt.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'ezzaeskardi-afk';
const REPO = 'EZ_scanner';
const RED_TITLE = 'Flake hunt went red';

/** One scheduled hunt the receipt accounts for. */
export interface ScheduledHunt {
  databaseId: number;
  createdAt: string;
  workflowName: string;
  event: string;
  conclusion: string;
  displayTitle: string;
  headSha: string;
  updatedAt: string;
}

/** An open-or-closed red-hunt thread, as the reporter left it. */
export interface RedThread {
  number: number;
  createdAt: string;
  closedAt: string | null;
  body: string;
}

/** The whole receipt: what ran, what passed, and every red with its evidence. */
export interface HuntReceipt {
  since: Date;
  until: Date;
  hunts: ScheduledHunt[];
  green: Array<{ hunt: ScheduledHunt; passes: number; load: number; sha: string; label: string }>;
  reds: Array<{
    hunt: ScheduledHunt | null;
    sha: string;
    passes: number;
    ok: number;
    timedOut: number;
    failing: number;
    verdictTable: string;
    artifactUrl: string;
    downloadUrl: string;
    threads: RedThread[];
  }>;
}

const ISO = (date: Date): string => date.toISOString();
const SHA7 = (sha: string): string => (sha.length >= 7 ? sha.slice(0, 7) : sha || '—');
const day = (iso: string): string => iso.slice(0, 10);

/** `passRow`'s shape, counted — only trustworthy when a text really carries rows, which run titles do not. */
export function passRowCounts(summary: string): { passes: number; ok: number; timedOut: number; failing: number } {
  const counts = { passes: 0, ok: 0, timedOut: 0, failing: 0 };
  for (const [, result] of summary.matchAll(/\| \d+ \| (ok|timed out|\d+ failing) \|/g)) {
    counts.passes += 1;
    if (result === 'ok') counts.ok += 1;
    else if (result === 'timed out') counts.timedOut += 1;
    else counts.failing += 1;
  }
  return counts;
}

/** The `### Verdict` block the hunt appends after its per-pass rows — embedded whole in the thread. */
export function verdictOf(body: string): string {
  const start = body.indexOf('### Verdict');
  if (start === -1) return '_the thread carries no verdict table (a run predating the summary copy — see the run page)_';
  return body.slice(start).trim();
}

/** Headline like the commit subject a run is titled with, minus the release-gate job prefix. */
export function headlineOf(displayTitle: string): string {
  const separator = displayTitle.indexOf(' / ');
  const job = separator === -1 ? displayTitle : displayTitle.slice(separator + 3).trim();
  return job.replace(/\s+/g, ' ').trim() || displayTitle;
}

export function artifactUrl(runId: number): string {
  return `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}#artifact`;
}

/** The artifact's download page, which lists `flake-hunt-results.json` for any signed-in reader. */
export function artifactDownload(runId: number): string {
  return `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}/artifacts`;
}

/** Scheduled runs only — a dispatch or a release-gate hunt is hand-watched and does not belong in the net's ledger. The gate and dispatches share the workflow's name, so the event column is the truth. */
export function scheduledOnly(hunts: ScheduledHunt[]): ScheduledHunt[] {
  const scheduled = hunts.filter((hunt) => hunt.event === 'schedule');
  if (scheduled.length === 0 && hunts.length > 0) {
    throw new Error('no scheduled hunts in the window — the fetch is filtering on the wrong column');
  }
  return scheduled;
}

/** The receipt for a window: greens as a table, every red as its own evidence block. */
export function buildReceipt(hunts: ScheduledHunt[], threads: RedThread[], since: Date, until: Date): HuntReceipt {
  const inWindow = hunts
    .filter((hunt) => {
      const at = new Date(hunt.createdAt);
      return at >= since && at <= until;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const threadsInWindow = threads.filter((thread) => {
    const at = new Date(thread.createdAt);
    // 48h of slack: a red period still running when the window opened has its thread from
    // before `since`, and the reds inside the window are still that thread's to carry.
    return at.getTime() >= since.getTime() - 48 * 60 * 60 * 1000 && at <= until;
  });
  const usedThreads = new Set<number>();
  const receipt: HuntReceipt = { since, until, hunts: inWindow, green: [], reds: [] };

  for (const hunt of inWindow) {
    const counts = passRowCounts(hunt.displayTitle);
    const isRed = hunt.conclusion !== 'success';
    if (!isRed) {
      const shape = scheduledShape(hunt);
      receipt.green.push({ hunt, passes: shape.passes, load: shape.load, sha: SHA7(hunt.headSha), label: shape.label });
      continue;
    }
    // A red period's first thread carries the verdict; later reds comment on the same thread.
    // The issue opens minutes AFTER the failed run finishes, and the next night's red hunts
    // that same ongoing period — so ±48h either direction is the window that catches both.
    const attached = threadsInWindow.filter((thread) => {
      if (usedThreads.has(thread.number)) return false;
      const gap = new Date(hunt.createdAt).getTime() - new Date(thread.createdAt).getTime();
      return Math.abs(gap) < 48 * 60 * 60 * 1000;
    });
    for (const thread of attached) usedThreads.add(thread.number);
    receipt.reds.push({
      hunt,
      sha: SHA7(hunt.headSha),
      // Run titles are commit subjects — they carry no pass rows. Counts appear only when a
      // text really held them; otherwise the verdict table is the count of record.
      passes: counts.passes,
      ok: counts.ok,
      timedOut: counts.timedOut,
      failing: counts.failing,
      verdictTable: attached.length ? verdictOf(attached[0].body) : '_no red-hunt thread opened for this run (see the run page for the summary)_',
      artifactUrl: artifactUrl(hunt.databaseId),
      downloadUrl: artifactDownload(hunt.databaseId),
      threads: attached,
    });
  }
  return receipt;
}

/**
 * The shape a scheduled run asked for, from its DURATION: GitHub's schedule queue delays starts
 * by hours, so the clock time is a liar — but the nightly (5 passes, load 2) runs ~6 minutes and
 * Sunday's heavy net (30 passes, load 3) ~36, and the delay does not change how long a hunt runs.
 * A heavy hunt killed under 15 minutes would read as a nightly; the verdict table and artifact
 * carry the truth, this label is only the ledger's shorthand.
 */
export function scheduledShape(hunt: ScheduledHunt): { passes: number; load: number; label: string } {
  const seconds = (new Date(hunt.updatedAt).getTime() - new Date(hunt.createdAt).getTime()) / 1000;
  if (seconds >= 15 * 60) return { passes: 30, load: 3, label: "Sunday heavy hunt (30×load 3)" };
  return { passes: 5, load: 2, label: "nightly (5×load 2)" };
}

/** The receipt as markdown — the one page the week's hunts add up to. */
export function renderReceipt(receipt: HuntReceipt): string {
  const lines: string[] = [
    `## Hunt receipt — ${day(ISO(receipt.since))} → ${day(ISO(receipt.until))}`,
    '',
    `${receipt.hunts.length} scheduled hunt(s): **${receipt.green.length} green**, **${receipt.reds.length} red**.`,
    '',
  ];
  if (receipt.green.length) {
    lines.push('| date | hunt | passes | load | commit |', '|---|---|---:|---:|---|');
    for (const { hunt, passes, load, sha, label } of receipt.green) {
      lines.push(`| ${day(hunt.createdAt)} | ${label} | ${passes || '—'} | ${load || '—'} | ${sha} |`);
    }
    lines.push('');
  }
  if (!receipt.reds.length) {
    lines.push('No reds. The verdicts said it plainly: no flake showed up in any window this week.');
    return lines.join('\n');
  }
  lines.push(`### Reds (${receipt.reds.length})`, '');
  for (const red of receipt.reds) {
    const when = red.hunt ? day(red.hunt.createdAt) : 'date unknown';
    lines.push(`#### ${when}${red.hunt ? ` — ${scheduledShape(red.hunt).label}` : ''}`, '');
    lines.push(`commit \`${red.sha}\`` + (red.passes ? ` · ${red.passes} pass(es): ${red.ok} ok, ${red.failing} failing, ${red.timedOut} timed out` : ''), '');
    lines.push(red.verdictTable, '');
    lines.push(`[run page](${red.artifactUrl}) · [artifact download](${red.downloadUrl})`);
    if (red.threads.length) {
      const links = red.threads.map((thread) => `#${thread.number}${thread.closedAt ? ' (closed)' : ' (open)'}`).join(', ');
      lines.push(`issue thread: ${links}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

type Gh = (args: string[]) => { ok: boolean; output: string };

function defaultGh(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** `gh` intermittently TLS-times out on this machine; one retry is the whole ceremony. */
function withRetry(gh: Gh, args: string[]): { ok: boolean; output: string } {
  const first = gh(args);
  if (first.ok) return first;
  const second = gh(args);
  return second.ok ? second : first;
}

function fetchJson(gh: Gh, args: string[], what: string): unknown {
  const result = withRetry(gh, args);
  if (!result.ok) throw new Error(`gh could not read ${what}: ${result.output}`);
  try {
    return JSON.parse(result.output);
  } catch {
    throw new Error(`gh returned unparseable JSON for ${what}`);
  }
}

/** The week's hunts and threads, straight from the API. */
export function fetchWeek(gh: Gh, since: Date): { hunts: ScheduledHunt[]; threads: RedThread[] } {
  const hunts = fetchJson(
    gh,
    ['api', `repos/${OWNER}/${REPO}/actions/runs?created=%3E%3D${ISO(since)}&per_page=100`],
    'the workflow runs',
  ) as { workflow_runs?: Array<Record<string, unknown>> };
  const threads = fetchJson(
    gh,
    ['api', `repos/${OWNER}/${REPO}/issues?state=all&sort=created&direction=desc&per_page=30`],
    'the issue threads',
  ) as Array<Record<string, unknown>>;

  return {
    hunts: (hunts.workflow_runs ?? []).map((run) => ({
      databaseId: run.id as number,
      createdAt: run.created_at as string,
      workflowName: run.name as string,
      conclusion: (run.conclusion as string) ?? '',
      displayTitle: run.display_title as string,
      headSha: (run.head_sha as string) ?? '',
      updatedAt: (run.updated_at as string) ?? '',
      event: (run.event as string) ?? '',
    })),
    threads: (threads ?? [])
      .filter((issue) => issue.title === RED_TITLE)
      .map((issue) => ({
        number: issue.number as number,
        createdAt: issue.created_at as string,
        closedAt: (issue.closed_at as string | null) ?? null,
        body: (issue.body as string) ?? '',
      })),
  };
}

if (process.argv[1]?.endsWith('hunt-receipt.ts')) {
  const days = Number(process.argv[2] ?? 7);
  if (!Number.isInteger(days) || days < 1) {
    console.error('usage: node scripts/hunt-receipt.ts [days]  (default 7)');
    process.exit(2);
  }
  try {
    const until = new Date();
    const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
    const { hunts, threads } = fetchWeek(defaultGh, since);
    const scheduled = scheduledOnly(hunts);
    console.log(renderReceipt(buildReceipt(scheduled, threads, since, until)));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
