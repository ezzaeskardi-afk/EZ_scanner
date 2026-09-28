/**
 * The red-hunt reporter's contracts.
 *
 * The reporter is bookkeeping on top of an already-red hunt, so its own failures must be
 * quiet; but its *decisions* — new thread vs comment vs close, and the body each call
 * carries — are what make "one thread per red period" real. The bodies are pinned as text;
 * the state transitions run against an injected recorder standing in for `gh`, whose
 * transcript the tests read.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  closeBody,
  closeThread,
  commentBody,
  findThread,
  ISSUE_TITLE,
  issueBody,
  openThread,
  runContext,
  type GhRunner,
} from '../scripts/report-red-hunt.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTEXT = {
  runUrl: 'https://github.com/ezzaeskardi-afk/EZ_scanner/actions/runs/36476214444',
  runId: '36476214444',
  sha: 'b73af144326305de3eb5e037a1480f66e4bb7d9a',
};
const SUMMARY = ['## Flake hunt', '', '| pass | result |', '|---:|---|', '| 1 | ok |', '', '### Verdict', '', 'flaked.'].join('\n');

test('the bodies carry the run link, the commit and the hunt summary', () => {
  const body = issueBody(CONTEXT, SUMMARY);
  assert.match(body, /scheduled hunt went red/);
  assert.match(body, /\[run 36476214444\]\(https:\/\/github\.com\/ezzaeskardi-afk\/EZ_scanner\/actions\/runs\/36476214444\)/, 'a valid markdown link, no spaces inside the parentheses');
  assert.match(body, /`b73af14`/);
  assert.ok(body.includes(SUMMARY), 'the hunt summary is embedded whole');
  assert.match(body, /first green hunt closes this issue/);

  const comment = commentBody(CONTEXT, SUMMARY);
  assert.match(comment, /^Another red hunt — \[run 36476214444\]/);
  assert.ok(comment.includes(SUMMARY));

  assert.match(closeBody(CONTEXT), /^The hunt went green — \[run 36476214444\]/);
  assert.match(closeBody(CONTEXT), /`b73af14`/);
});

test('the context falls back through env, URL and "unknown"', () => {
  assert.equal(runContext({ HUNT_RUN_URL: 'https://x/runs/123' }).runId, '123', 'id derived from the URL');
  assert.equal(runContext({ HUNT_RUN_ID: '777', HUNT_RUN_URL: 'https://x/runs/123' }).runId, '777', 'explicit id wins');
  assert.equal(runContext({}).runId, 'unknown');
  assert.equal(runContext({}).runUrl, '');
  const body = issueBody({ runUrl: '', runId: 'unknown', sha: '' }, SUMMARY);
  assert.match(body, /went red — run unknown\./, 'no empty markdown link when the URL is missing');
});

interface Recorder {
  run: GhRunner;
  calls: string[][];
  bodies: string[];
}

/** Stands in for `gh`: records every call, answers `issue list` from `state`, reads body files. */
function recorder(state: { list: string; ok?: boolean; output?: string }): Recorder {
  const calls: string[][] = [];
  const bodies: string[] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') {
      return { ok: true, output: state.list };
    }
    const at = args.indexOf('--body-file');
    if (at !== -1) bodies.push(readFileSync(args[at + 1]!, 'utf8'));
    return { ok: state.ok ?? true, output: state.output ?? 'https://github.com/ezzaeskardi-afk/EZ_scanner/issues/7' };
  };
  return { run, calls, bodies };
}

const OPEN = JSON.stringify([{ number: 7, state: 'OPEN' }]);
const CLOSED = JSON.stringify([{ number: 7, state: 'CLOSED' }]);
const NONE = '[]';

test('open with no thread creates the issue titled "Flake hunt went red"', () => {
  const fake = recorder({ list: NONE });
  assert.equal(openThread(CONTEXT, SUMMARY, '/tmp', fake.run), true);
  assert.deepEqual(fake.calls.map((args) => args.slice(0, 2).join(' ')), ['issue list', 'issue create']);
  const create = fake.calls[1]!;
  assert.ok(create.includes('--title') && create.includes(ISSUE_TITLE));
  assert.match(fake.bodies[0]!, /scheduled hunt went red/);
});

test('open with an open thread comments instead of duplicating', () => {
  const fake = recorder({ list: OPEN });
  openThread(CONTEXT, SUMMARY, '/tmp', fake.run);
  assert.deepEqual(fake.calls.map((args) => args.slice(0, 2).join(' ')), ['issue list', 'issue comment']);
  assert.equal(fake.calls[1]![2], '7');
  assert.match(fake.bodies[0]!, /^Another red hunt — /);
});

test('open with a hand-closed thread opens a fresh one instead of reopening the muted one', () => {
  const fake = recorder({ list: CLOSED });
  openThread(CONTEXT, SUMMARY, '/tmp', fake.run);
  assert.deepEqual(fake.calls.map((args) => args.slice(0, 2).join(' ')), ['issue list', 'issue create']);
});

test('a failing gh create is reported but never throws', () => {
  const fake = recorder({ list: NONE, ok: false, output: 'gh: auth required' });
  assert.equal(openThread(CONTEXT, SUMMARY, '/tmp', fake.run), false);
});

test('close closes the open thread with the green comment', () => {
  const fake = recorder({ list: OPEN });
  assert.equal(closeThread(CONTEXT, '/tmp', fake.run), true);
  assert.deepEqual(fake.calls.map((args) => args.slice(0, 2).join(' ')), ['issue list', 'issue close']);
  const close = fake.calls[1]!;
  assert.equal(close[2], '7');
  assert.ok(close.includes('--comment') && close.includes(closeBody(CONTEXT)));
});

test('close with no thread, or an already-closed one, is a no-op success', () => {
  const none = recorder({ list: NONE });
  assert.equal(closeThread(CONTEXT, '/tmp', none.run), true);
  assert.deepEqual(none.calls.map((args) => args[0]), ['issue']);

  const closed = recorder({ list: CLOSED });
  assert.equal(closeThread(CONTEXT, '/tmp', closed.run), true);
  assert.deepEqual(closed.calls.map((args) => args[0]), ['issue']);
});

test('findThread reads gh failures and malformed JSON as "no thread"', () => {
  assert.equal(findThread('/tmp', () => ({ ok: false, output: 'gh: not authenticated' })), null);
  assert.equal(findThread('/tmp', () => ({ ok: true, output: 'not json' })), null);
  assert.deepEqual(findThread('/tmp', () => ({ ok: true, output: OPEN }))?.number, 7);
});

test('the CLI exits zero even when gh is unreachable — a red reporter must not bury a red hunt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-hunt-cli-'));
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'report-red-hunt.ts'), 'open'], {
      cwd: dir,
      env: { ...process.env, PATH: '' },
      stdio: 'ignore',
    });
    execFileSync(process.execPath, [join(root, 'scripts', 'report-red-hunt.ts'), 'close'], {
      cwd: dir,
      env: { ...process.env, PATH: '' },
      stdio: 'ignore',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
