/**
 * The flake hunt: run the integration suite again and again on a machine that is busy, so a race
 * surfaces here — on a schedule — instead of inside a release.
 *
 * Why it exists. 1.7.4 shipped a test that failed on a runner while passing everywhere the suite
 * was run once: `resets make the scanner slow itself down instead of hammering` asserted a worker
 * budget on the fake access network's session count, which is a couple of event-loop turns behind
 * what the scanner is doing. A single pass in a quiet job misses that by construction; the same
 * suite repeated on a machine with no spare CPU finds it. (1.7.5 fixed the assertion; this is what
 * would have said so before the tag was cut.)
 *
 * The load is the *machine* being busy, not the tests being parallel. `npm test` already runs the
 * files with `--test-concurrency=1`, and a real runner is shared, so the contention that produced
 * that failure was CPU time taken away from the process — which is exactly what the busy workers
 * here do, on purpose and reproducibly.
 *
 * The classification is the point of the output: a test that fails in *some* runs and passes in
 * others has a race in it (fix the test, or the code it measures), while one that fails in *every*
 * run is simply broken. A hunt that only said "red" would leave that judgement to the reader.
 *
 *   node scripts/flake-hunt.ts                        # 3 runs of the integration files
 *   node scripts/flake-hunt.ts --runs 6               # a longer hunt, for a suspicious week
 *   node scripts/flake-hunt.ts --files test/server.test.ts --runs 20 --load 0
 *   node scripts/flake-hunt.ts --help
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The files that drive a real scan against the fake access network (`test/helpers/hostile-line.ts`).
 * They are the slow ones and the racy ones, and `test/flake-hunt.test.ts` fails if a test file
 * starts using that harness without being listed here — a hunt over a stale list would go quiet
 * exactly when a new one is added.
 */
export const INTEGRATION_FILES = [
  'test/hostile-line.test.ts',
  'test/operator-profiles.test.ts',
  'test/recovery-pass.test.ts',
  'test/cli.test.ts',
  'test/doctor-signature.test.ts',
];

export interface TestFailure {
  /** The test's name, as the reporter printed it. */
  name: string;
  /** The assertion's own message, lifted out of the reporter's diagnostic block. */
  error: string;
}

export interface RunResult {
  /** Tests the run reported (`1..N` in the TAP stream). */
  total: number;
  pass: number;
  failed: TestFailure[];
  seconds: number;
  /** Killed at the timeout: this run says nothing about any test. */
  timedOut: boolean;
}

export interface FlakeReport {
  /** Failed in some runs and passed in others — the shape this hunt exists to catch. */
  flaked: Array<TestFailure & { runs: number; of: number }>;
  /** Failed in every run that finished: not a race, a real break. */
  consistent: TestFailure[];
  /** Runs that never finished; they are excluded from the counts above. */
  timedOut: number;
  runs: number;
}

/**
 * The failing top-level tests in one TAP stream, with the message for each.
 *
 * The reporter indents a subtest's own result *and* reports the parent that failed because of it,
 * so reading every `not ok` would count one failure twice. Only column-zero lines are read: a
 * nested failure arrives as its parent, which is the test that has to be fixed anyway. The message
 * comes from the block that follows the line, where the reporter puts the assertion's text.
 *
 * It writes that message two ways, and both are read here: inline (`error: 'a budget was
 * exceeded'`, which is what an assertion with a message and no extra detail produces) and as a
 * block (`error: |-`, which is what a diff or a second line turns it into).
 */
export function failuresOf(tap: string): TestFailure[] {
  const failures: TestFailure[] = [];
  let current: { name: string; error: string[] } | null = null;
  let inError = false;

  const close = (): void => {
    if (current) failures.push({ name: current.name, error: current.error.join('\n').trim() });
    current = null;
    inError = false;
  };

  for (const line of tap.split(/\r?\n/)) {
    const failed = /^not ok \d+ - (.+?)\s*$/.exec(line);
    if (failed) {
      close();
      current = { name: failed[1], error: [] };
      continue;
    }
    if (!current) continue;
    const inline = /^ {2}error: '(.*)'\s*$/.exec(line);
    if (inline) {
      current.error.push(inline[1].replace(/\\(['\\])/g, '$1'));
      continue;
    }
    if (/^ {2}error: \|-\s*$/.test(line)) {
      inError = true;
      continue;
    }
    if (inError && /^ {4}/.test(line)) {
      current.error.push(line.trim());
      continue;
    }
    inError = false;
    // A sibling's result, or the end of this test's block: either way this failure is complete.
    if (/^ {2}\.\.\.\s*$/.test(line) || /^ok \d+ - /.test(line) || /^not ok \d+ - /.test(line)) close();
  }
  close();
  return failures;
}

/**
 * What the run did, counted from the results themselves rather than from the reporter's summary:
 * with several files the stream carries a line per test, and a count taken from those cannot
 * disagree with the failures parsed out of the same lines.
 */
function summaryOf(tap: string): { total: number; pass: number } {
  let pass = 0;
  let failed = 0;
  for (const line of tap.split(/\r?\n/)) {
    if (/^ok \d+ - /.test(line)) pass += 1;
    else if (/^not ok \d+ - /.test(line)) failed += 1;
  }
  return { total: pass + failed, pass };
}

/** "It failed in some runs and not others", separated from "it failed every time". */
export function classify(runs: RunResult[]): FlakeReport {
  const completed = runs.filter((run) => !run.timedOut);
  const seen = new Map<string, { error: string; runs: number }>();
  for (const run of completed) {
    for (const failure of run.failed) {
      const known = seen.get(failure.name);
      if (known) known.runs += 1;
      else seen.set(failure.name, { error: failure.error, runs: 1 });
    }
  }
  const report: FlakeReport = {
    flaked: [],
    consistent: [],
    timedOut: runs.length - completed.length,
    runs: runs.length,
  };
  for (const [name, failure] of seen) {
    if (failure.runs >= completed.length) report.consistent.push({ name, error: failure.error });
    else report.flaked.push({ name, error: failure.error, runs: failure.runs, of: completed.length });
  }
  return report;
}

/** One pass of the files, as its own process — the same way `npm test` runs them. */
function runOnce(files: string[], timeoutSeconds: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } },
    );
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);
    // Both streams: the reporter writes TAP to stdout, but a crash writes its own words to stderr.
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({
        ...summaryOf(out),
        failed: failuresOf(out),
        seconds: (Date.now() - started) / 1000,
        timedOut,
      });
    });
  });
}

/**
 * Busy processes, not sleeping ones: the point is to take CPU away from the run. They stop
 * themselves at `seconds` as well as being killed, so a hunt that dies unexpectedly does not
 * leave a runner spinning until the job's own timeout.
 */
function startLoad(count: number, seconds: number): () => void {
  const workers: ChildProcess[] = [];
  for (let i = 0; i < count; i += 1) {
    workers.push(
      spawn(process.execPath, ['-e', `const end = Date.now() + ${Math.round(seconds * 1000)}; while (Date.now() < end) Math.sqrt(Math.random());`], {
        stdio: 'ignore',
      }),
    );
  }
  return () => {
    for (const worker of workers) worker.kill();
  };
}

/** A job log needs admin rights to fetch through the API; an annotation is visible where the fix is. */
function annotate(message: string): void {
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${message}`);
}

/* ------------------------------- job summary ------------------------------- */

/** Escape for a markdown table cell: a pipe would split the cell, a newline would split the row. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** The table's head, written once before the first pass appends its row under it. */
export const PASS_TABLE_HEADER =
  '| pass | result | tests | passing | failing | seconds |\n|----:|--------|------:|--------:|--------:|--------:|';

/** One pass, one row — appended to the job summary as the pass finishes, so a killed job still shows the passes it got through. */
export function passRow(index: number, run: RunResult): string {
  if (run.timedOut) return `| ${index} | timed out | — | — | — | — |`;
  const result = run.failed.length ? `${run.failed.length} failing` : 'ok';
  return `| ${index} | ${result} | ${run.total} | ${run.pass} | ${run.failed.length || '—'} | ${run.seconds.toFixed(1)} |`;
}

export interface HuntMeta {
  runs: number;
  load: number;
  files: string[];
  timeout: number;
}

/**
 * The hunt's judgement as a table. The per-pass rows above say what happened pass by pass; this
 * says what to do about it — a flake and a break want different fixes, and the green case says
 * plainly that nothing showed up *in this window* rather than implying the tests are race-free.
 */
export function verdictTable(report: FlakeReport, meta: HuntMeta): string {
  const completed = report.runs - report.timedOut;
  const lines: string[] = [
    '### Verdict',
    '',
    `${meta.runs} pass(es) · load ${meta.load} · ${meta.files.length} file(s) · timeout ${meta.timeout}s`,
    '',
  ];
  if (report.timedOut) lines.push(`${report.timedOut} pass(es) never finished and are excluded from the counts below.\n`);
  if (!report.flaked.length && !report.consistent.length) {
    lines.push('Every run passed — no flake showed up in this window.');
    return lines.join('\n');
  }
  lines.push('| test | failed | of | first message |', '|---|---:|---:|---|');
  for (const failure of report.flaked) {
    lines.push(`| ${cell(failure.name)} | ${failure.runs} | ${failure.of} | ${cell(failure.error.split('\n')[0] ?? '')} |`);
  }
  for (const failure of report.consistent) {
    lines.push(`| ${cell(failure.name)} | ${completed} | ${completed} | ${cell(failure.error.split('\n')[0] ?? '')} |`);
  }
  lines.push('', 'Failing in some runs is a race (fix the test or what it measures); failing in every run is a break.');
  return lines.join('\n');
}

/** Appends to the job summary on GitHub; a local run has no sink and says nothing extra. */
function writeSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, markdown);
  } catch {
    // The summary is evidence, not a gate: a bad path or a full disk must not fail the hunt.
  }
}

/**
 * The hunt's evidence, written to the path in `FLAKE_HUNT_RESULTS` when one is set: the run's
 * parameters, every pass as recorded, and — once the hunt can make one — the verdict. It is
 * rewritten after each pass, so a job killed mid-hunt still leaves the passes it got through;
 * only a missing `verdict` says the hunt never finished classifying. The workflow uploads the
 * file as an artifact, so the evidence outlives the job log that also holds it.
 */
export interface HuntResultsFile {
  startedAt: string;
  runs: number;
  load: number;
  files: string[];
  timeoutSeconds: number;
  passes: RunResult[];
  verdict?: FlakeReport;
}

/**
 * Best-effort: evidence must never be the thing that fails a hunt. False when skipped (no sink
 * set — the local case, silent by design) or unwritable — and the unwritable case is *loud*,
 * because a sink that was asked for and silently never produced the file would fail an artifact
 * upload two steps later with no clue why.
 */
export function writeResultsFile(record: HuntResultsFile): boolean {
  const path = process.env.FLAKE_HUNT_RESULTS;
  if (!path) return false;
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch (err) {
    console.error(`flake hunt: could not write the evidence file (${path}): ${(err as Error).message}`);
    return false;
  }
}

interface Options {
  runs: number;
  files: string[];
  load: number | null;
  timeout: number;
}

/** `help` for `--help`, `null` for a bad invocation — the two exit differently. */
function parseArgs(argv: string[]): Options | 'help' | null {
  const options: Options = { runs: 3, files: [], load: null, timeout: 600 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return 'help';
    const value = argv[i + 1];
    const parsed = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
    if (flag === '--files') {
      if (!value) {
        console.error('--files needs a comma-separated list');
        return null;
      }
      options.files = value.split(',').map((file) => file.trim()).filter(Boolean);
    } else if (flag === '--runs' || flag === '--load' || flag === '--timeout') {
      if (!Number.isFinite(parsed)) {
        console.error(`${flag} needs a number`);
        return null;
      }
      if (flag === '--runs') options.runs = Math.max(1, Math.floor(parsed));
      else if (flag === '--load') options.load = Math.max(0, Math.floor(parsed));
      else options.timeout = Math.max(30, Math.floor(parsed));
    } else {
      console.error(`unknown option: ${flag}`);
      return null;
    }
    i += 1; // the value was just consumed
  }
  return options;
}

const banner = `flake hunt — integration suite, repeated on a busy machine

  node scripts/flake-hunt.ts [--runs 3] [--files a.test.ts,b.test.ts] [--load N] [--timeout 600]

  --runs     passes over the same files (default 3)
  --files    comma-separated files, instead of the integration suite (default: see INTEGRATION_FILES)
  --load     busy processes to add (default: one per CPU but one, 2..16); 0 for a quiet machine
  --timeout  seconds before a single pass is killed (default 600)
`;

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options === 'help') {
    console.log(banner);
    return 0;
  }
  if (!options) {
    console.log(banner);
    return 2;
  }
  const cores = cpus().length;
  const load = options.load ?? Math.max(2, Math.min(16, cores - 1));
  const files = options.files.length ? options.files : INTEGRATION_FILES;
  console.log(`flake hunt: ${options.runs} runs of ${files.length} file(s), ${load} busy process(es) on ${cores} CPU(s)`);
  console.log(`  ${files.join('\n  ')}`);

  // The summary is written incrementally, so a job killed mid-hunt still shows the passes it got
  // through; the verdict lands under the table when the hunt can actually make one.
  writeSummary(`## Flake hunt\n\n${PASS_TABLE_HEADER}\n`);

  // The evidence file follows the same discipline: every pass lands in it the moment it is
  // measured, so an interrupted hunt still uploads the passes it completed.
  const resultsFile: HuntResultsFile = {
    startedAt: new Date().toISOString(),
    runs: options.runs,
    load,
    files,
    timeoutSeconds: options.timeout,
    passes: [],
  };
  writeResultsFile(resultsFile);

  const stopLoad = startLoad(load, options.runs * (options.timeout + 30) + 60);
  const runs: RunResult[] = [];
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      const result = await runOnce(files, options.timeout);
      runs.push(result);
      resultsFile.passes.push(result);
      writeResultsFile(resultsFile);
      writeSummary(passRow(run, result) + '\n');
      const seconds = result.seconds.toFixed(0);
      if (result.timedOut) {
        console.log(`run ${run}/${options.runs}: killed after ${options.timeout}s`);
        annotate(`flake hunt: run ${run} of ${options.runs} never finished (timeout ${options.timeout}s)`);
        continue;
      }
      console.log(`run ${run}/${options.runs}: ${result.failed.length ? `${result.failed.length} failing` : 'ok'} (${result.pass}/${result.total} passing, ${seconds}s)`);
      for (const failure of result.failed) {
        console.log(`FAILED ${failure.name}`);
        for (const line of failure.error.split('\n').slice(0, 4)) console.log(`  ${line}`);
        annotate(`flake hunt: ${failure.name} — ${failure.error.split('\n')[0] ?? 'failed'}`);
      }
    }
  } finally {
    stopLoad();
  }

  const report = classify(runs);
  resultsFile.verdict = report;
  writeResultsFile(resultsFile);
  writeSummary(`\n${verdictTable(report, { runs: options.runs, load, files, timeout: options.timeout })}\n`);
  console.log('');
  console.log(`flake hunt: ${options.runs} runs, ${report.timedOut} never finished`);
  if (!report.flaked.length && !report.consistent.length && !report.timedOut) {
    console.log('  every run passed — no flake showed up in this window');
    return 0;
  }
  if (report.flaked.length) {
    console.log(`  failed in some runs, passed in others (a race: fix the test or what it measures): ${report.flaked.length}`);
    for (const failure of report.flaked) {
      console.log(`    - ${failure.name} — failed ${failure.runs} of ${failure.of} completed runs`);
      console.log(`      ${failure.error.split('\n')[0] ?? ''}`);
    }
    annotate(`flake hunt: ${report.flaked.length} flaking test(s) — ${report.flaked.map((f) => f.name).join(' · ')}`);
  }
  if (report.consistent.length) {
    console.log(`  failed in every run that finished (not a race — the test is doing its job): ${report.consistent.length}`);
    for (const failure of report.consistent) {
      console.log(`    - ${failure.name}`);
      console.log(`      ${failure.error.split('\n')[0] ?? ''}`);
    }
  }
  return 1;
}

if (process.argv[1]?.endsWith('flake-hunt.ts')) {
  process.exit(await main());
}
