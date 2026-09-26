# Changelog

## 1.7.7 — 2026-09-26

This release is the pipeline learning to watch itself. 1.7.6 shipped the flake hunt; this one
wires it into the release path — a tag is now hunted on its own commit before anything is
packaged — and answers the question the 1.7.6 flake exposed: `stats.backoffFactor` was a
decaying last-address value being read as a whole-run claim. The sweep's real peak is now a
stat of its own, on screen and in the run's own records, with the decay semantics that caused
the drift pinned in unit tests.

### Added
- **`stats.peakBackoffFactor`** — the sweep's high-water mark for the inter-probe backoff,
  recorded where the delay is actually applied, next to `backoffFactor`, which stays the live,
  per-address value that decays toward 1 as the line recovers (÷1.3 whenever the failure ratio
  drops under 0.25). The GUI status line reads both side by side — `backoff ×1.32 (peak ×8.00)`
  — with the peak falling back across snapshot ages so pre-1.7.7 snapshots still render. A
  resumed run inherits the saved peak as its floor and can only raise it, while the live factor
  restarts at 1 with the reset engine: `restore()` used to let the resumed run display the
  previous run's last-address number, a decay the current sweep never earned.
- **The release waits on a green flake hunt of the tagged commit.** The release workflow calls
  `flake.yml` (`workflow_call`) with six passes at load 3 and publishes nothing until it is
  green. A called workflow gets a fresh workspace, where a bare checkout takes `github.sha` —
  the commit the caller ran on, not the one it ships — so the hunt takes a `ref` input and the
  release passes its tag: the commit under the hammer is the commit being shipped, on the tag
  push and on a dispatched re-publish alike. A red hunt fails the release; the tag is not
  rewritten — the fix lands on `main` and the next tag carries it.
- **Every hunt leaves a browsable record.** The per-pass table is written to the job summary
  row by row as each pass finishes (a job killed mid-hunt still shows the passes it got
  through), with the verdict beneath it — flakes with their failure ratio, breaks with their
  certainty, and a green window that says so plainly rather than implying the tests are
  race-free. Each hunt also uploads `flake-hunt-results.json` as a workflow artifact, even on
  failure, rewritten after every pass; the evidence outlives the job log that also holds it.
- **A weekly heavy hunt.** Sunday nights run thirty passes at load 3 — the scale that caught
  the burst-precondition flake in the 1.7.6 A/B experiment — for races too rare to meet in a
  single night; the nightly stays the cheap floor (three passes, load 2), and a scheduled run
  tells itself apart by its cron string.

### Fixed
- **The reset-churn budget assertion measures what the run did.** `the failure ratio raised
  the inter-probe delay` read `stats.backoffFactor` after the sweep — the *last* completed
  address's value, which decays, so a sweep that slowed hard and finished on a string of
  successes read 4 where it peaked at 8 (measured 8.00 → 4.32). That is the shape that flaked
  in CI on a docs-only commit after 1.7.6, with an annotation that said `expected: true`. The
  assertion now reads the peak the scanner itself recorded and its failure message carries the
  numbers; CI's failing-test grep lifts the TAP `error:` line so the message travels with the
  annotation.

### Tests
- 229 tests (+9): the backoff peak round-trip (`scanner.test.ts`), three decay-contract pins
  (`ratelimit.test.ts` — the step is exactly /1.3 on the record that crosses under 0.25, the
  floor at 1 is exact, and a ratio between 0.25 and the threshold holds the factor still), the
  status-line template and fallback (`gui.test.ts`), and four for the hunt's records — pass
  rows including timeouts, the green verdict, the flake/break table, and the evidence file's
  write/rewrite/skip paths. Verified by mutation (backoff disabled reads `peak 1, final 1,
  after 89 resets`) and by running the release gate end to end on v1.7.6: assets came back
  byte-identical and the re-extracted notes were corrected by hand.

## 1.7.6 — 2026-09-25

Two answers to the same question — *is this test telling the truth?* — because 1.7.4 shipped one that
was not, and nothing in the pipeline was built to notice before the tag was cut. 1.7.5 fixed that
assertion; this release is the machinery that would have found it, and the instrument that made the
claim legible once it was found. **Nothing the scanner does changes**: the diff reaches `src/` only
to bump the version literals, so a 1.7.5 install scans exactly as this one does. What is added is a
way to meet a flaky claim on a schedule instead of on a release day, and a concurrency count that
cannot run ahead of the thing it is counting.

### Added
- **A flake hunt, on a schedule.** `scripts/flake-hunt.ts` runs the integration files — the ones
  that drive a real scan against the fake access network — again and again with a busy process per
  CPU on top. The load is the *machine* being busy rather than the tests being parallel, which is
  the contention that produced the original failure: a real runner is shared, and CPU taken away
  from the process is what a quiet single pass cannot reproduce. It then separates what it found
  instead of only going red, because the two want different fixes: a test that fails in *some* runs
  has a race in it (the test, or the thing it measures), while one that fails in *every* run that
  finished is simply broken. Runs killed at the timeout are excluded from both counts — a starved
  pass says nothing about any test — and each failure is posted as an annotation against the commit
  on CI, with the assertion's own message, so which claim flaked does not depend on reading a job
  log through the API. `npm run check:flake` locally, with `--runs 6` for a longer hunt,
  `--files test/server.test.ts` to point it at one suspect, and `--load 0` to hunt without
  contention.
- **A nightly `Flake hunt` workflow**, and a dispatchable one: `gh workflow run flake.yml -f
  runs=6`, or `-f files=test/server.test.ts -f runs=20`. Nightly rather than on every push on
  purpose — repeated integration runs per push cost more than the answer is worth, and a flake
  should not block a push, it should be *known*. The job's own load is two busy processes on a
  4-vCPU runner (about half the machine, inside a 60-minute timeout), not the script's default of
  one per CPU but one, which is right on a developer's machine and reads as a timeout on a runner.

### Fixed
- **Plain TCP dials were silently uncounted by the new client counter.** `net.connect` hands
  `Socket.prototype.connect` the arguments it has *already* normalized, as an **array**, while
  `tls.connect` passes the options object itself — so a port check that only looked at
  `arguments[0]` counted one protocol and not the other. The symptom was specific: `opened` stuck at
  1 while the server had clearly accepted session 2. The extractor now recurses into an array.
- **A socket's end of life cannot be a `'close'` listener.** `destroy(socket)` in `src/core/net.ts`
  strips the socket's listeners before destroying it, so a counter waiting for `'close'` would leak
  every socket that path closed. The counter hooks `destroy` on the prototype as well, and both
  paths are idempotent through a `WeakMap`, so a socket is counted exactly once whichever way it
  goes.

### Tests
- 220 tests (+5). Two of them are the flake hunt's own: `test/flake-hunt.test.ts` pins the TAP
  reading (an inline `error:`, a block `error: |-`, and a subtest surfacing as the parent that
  failed, so one failure is not counted twice) and the flake/break split, including that a
  timed-out run is excluded; it also fails if a test file starts using the hostile-line harness
  without being listed as an integration file, because a hunt over a stale list goes quiet exactly
  when a new file is added. Verified to bite: removing `recovery-pass` from the list fails it.
- **The worker budget is now read off the caller's own sockets.** `test/helpers/client-sockets.ts`
  counts sockets the caller opened to the line and destroyed again (`live`, `peak`, `opened`), by
  patching `net.Socket.prototype.connect`/`destroy` while a watcher is registered, keyed by port, and
  restoring them when the last one stops. Both ends of a socket's life are on the caller's side of
  the wire, so unlike the line's `peakConcurrent` — which counts a session until it has *reaped* it,
  one loopback round-trip behind the caller — this number cannot lag. `HostileLine` exposes it as
  `line.client`, `resetStats()` resets it and `close()` stops it.
- The three budget assertions that were reading the line's session count now read the caller's:
  the burst test (`line.client.peak <= 6`), the reset-churn test (`line.client.peak <= 4`) and the
  operator-profile budgets (`clientPeak <= preset.workers`), each with a lower bound proving the
  count measured a scan that happened at all — `line.client.opened`, not a sampler. The parked-scan
  test gained `line.client.live === 0` while the scan waits out an outage, and the operator-profile
  evidence line now prints both numbers side by side, e.g. `peak 40 sockets (the line held 30)`.
- **The instrument has its own proof test.** 120 strictly serial TLS dials — concurrency 1 by
  construction — read `peak 1`, `opened 120`, `live 0` on the caller's side, which is the claim the
  budgets above rest on. The same loop read the line's own `peakConcurrent` **2 in 15 of 15 local
  rounds**, and that is deliberately not asserted: it is the lag being demonstrated, and on a
  machine slow enough for the line to reap a session before the next dial lands, 1 is the honest
  reading there too. The budget assertions were mutated to fail on purpose — doubling the pool in
  `probePhase` fails them with `peak 12 sockets must stay inside the worker budget of 6 …` and
  `the worker budget was respected throughout (widest 8 sockets, budget 4)` — and the mutation was
  reverted. `npm run check:flake -- --runs 2` is green, twice, under 15 busy processes; so is the
  full suite.

## 1.7.5 — 2026-09-24

One test in the previous release flaked in CI, and the tag was already cut when it did — so this
release is that flake made explainable and then gone. The assert was `line.stats.peakConcurrent <= 4`
in `resets make the scanner slow itself down instead of hammering`: a worker budget read off the fake
access network. That counter is not a count of what the scanner is doing. The line counts a session
from `accept` until it has **reaped** it, and reaping is one loopback round-trip behind the client
letting go of the socket, so the line goes on reporting sessions the scanner has already finished
with. The scan was never wide — the instrument was reading ahead of it. No shipped code changes in
1.7.5: what changed is how the claim is measured, and a note that stops the next reader from
measuring it the same way.

### Fixed
- **The worker budget is asserted on the client, not on sessions the line has not reaped yet.**
  Dialling the fake line strictly one socket at a time — client concurrency 1 by construction — still
  makes it report a peak of **2**, in every run: one session it is still holding after the caller has
  let go. Under the retry churn this test creates (85% of sessions reset, five tries each, no delay
  between them) the drift grows, and that is what the CI failure was. The assertion now samples
  `scanner.getStats().inflight` while the sweep runs — the number of addresses in flight, which *is*
  the budget and is unambiguous on the client side — with a self-check that the sampler observed the
  sweep, so a budget check that measured nothing cannot pass. What the line can prove is unchanged and
  still asserted: nothing was turned away, and the line was never dropped.
- **`peakConcurrent` now says what it can answer.** The field's doc records that a session is counted
  until the line reaps it, that the count therefore leads the client's own concurrency (measured: 2 for
  a strictly serial caller), and that it is the right instrument for the question the burst test asks
  — did the session table fill up — but not for a worker budget.

### Tests
- 215 tests, and the count does not move: this release changes how one existing test measures, not
  what it covers. The claim was verified from both ends. The instrument: across 38 runs under CPU load
  the scanner never had more than four sockets open at once (its own `inflight` peaked at 4, and so did
  a socket-level count taken on the client), while the line's peak on those same runs sat at 2–4 — on
  the boundary it flaked at. The mechanism: a strictly serial caller reads a line peak of 2, which no
  correct budget statement can rest on. And the new assertion was mutated to fail on purpose —
  doubling the pool in `probePhase` fails it with `the worker budget was respected throughout
  (widest 8 in flight, budget 4)` — then reverted. 18 runs of the test in six concurrent processes,
  the contention that produced the original flake, are green.

## 1.7.4 — 2026-09-23

The other half of a silent swap 1.7.3 fixed. A resume *with* settings runs the settings on screen;
a resume **without** them — `POST /api/scan/start` carrying only `{mode:'resume', resumeId}`, which
is what a script and a flagless `ezscan resume <id>` do — ran whatever config the server happened
to be holding, and threw away the settings the session was saved with. This release closes that
half, so the endpoint has one rule instead of two.

### Fixed
- **A resume that carries no settings keeps the session's own.** After the 1.7.3 override, the
  posted config was applied whenever the request was a resume, *including* when there was nothing to
  apply: `body.config` was `undefined`, so `start()` received the server's current config as the
  "form" and `restore()` never got to use the snapshot's. Measured on the endpoint: a session saved
  with `sni=the-sessions-own.example, workers=3` resumed with a bare
  `{mode:'resume', resumeId}` ran with `sni=somewhere-else.example, workers=7` — the server's config,
  which is the same silent replacement 1.7.3 removed, in the other direction, and a different
  answer from `ezscan resume <id>` with no flags. The override is now sent only when the request
  actually carries settings, and the resume path is spelled out in the README the same way the CLI's
  flag-as-patch rule is.

### Tests
- 215 tests (+1). `a resume that carries no settings keeps the session's own` in
  `test/server.test.ts` is self-contained — it saves a session under one set of settings, moves the
  server's own config somewhere else (asserted first, so the two can be told apart), then resumes
  with no config at all and reads back the config the run used. Verified to bite: with the previous
  behaviour it fails with `expected 'the-sessions-own.example', actual 'somewhere-else.example'`.

## 1.7.3 — 2026-09-23

A review pass over the whole tree again, and every entry below came out of running the code rather
than reading it. The two that matter most are about a promise the tool made and did not keep: the
GUI said one thing and scanned another (a resume silently ran the session's old settings instead of
the ones on screen), and `Re-probe` destroyed the throughput it was not asked to touch and raised
the score of the row it had just measured. The rest are the same family — a value, a verdict or an
export that *looked* right in all the places it was read from, and was not.

### Fixed
- **A resumed session runs the settings on screen.** `POST /api/scan/start` accepted the form's
  config on a resume, validated it, answered `ok`, warned about it and broadcast it back into the
  GUI — and then `Scanner.start()` let `restore()` replace the config with the snapshot's, so every
  value the user could read, and had just edited, was silently discarded before the first probe.
  Measured on the endpoint: posted `sni=typed-in-the-form.example, workers=3`, ran with
  `sni=from-the-session.example, workers=12`. The posted config is now applied on top of the
  session's own, so a resume keeps the session's addresses, cursor and results under the settings
  that are visible. (1.7.1 closed the same shape on the CLI, where the flags are a *patch* over the
  session's config; here the posted config is the whole form, so it is the form that wins.)
- **`Re-probe` no longer wipes the throughput — or raises the score for it.** `retest(keys, 'probe')`
  built a fresh record and wrote it over the row, and a fresh record has no throughput: the Mbps
  column emptied and the row was then scored with the speed term switched *off*, so "Re-probe"
  raised the score of the address it had just re-measured (measured: `downMbps 42.5 → 0`,
  `downTrust measured → untested`, `score 77 → 97`). The verdict is part of what the row measured, so
  it is carried across, and the batch pass re-runs so the neighbours are still normalised against a
  baseline that exists.
- **A shadowsocks link in its base64 form gets the discovered address.** The legacy form is one
  base64 blob over `method:password@host:port`, so its body carries no `@` for the rewriter to find;
  the rewrite fell through to "return the body unchanged" and `--links` (or the GUI's "build
  links") wrote N copies of the *original* server — every exported config pointing back at the
  address the user started from. The body is decoded, rewritten and re-encoded, the port override
  lands inside it, and the label names the discovery like every other scheme.
- **An `ss://` authority that is an IPv6 address parses as an address and a port.**
  `ss://…@2606:4700::1:2053` was read as address `2606` and port `4700` — a silently wrong target, on
  the address family half this tool's ranges use. The authority is taken whole now, brackets and all.
- **A malformed `--speed-url`/`--upload-url` is a config error, and it stays one.** Three defects in
  one path: the check accepted anything starting with `https://` (including `https://`, which the
  URL parser refuses), a value that failed the parse was *silently* swapped for Cloudflare's own
  endpoint — so the throughput phase measured a host the user never named, with that host as the SNI
  — and the upload URL dropped an invalid value without even the warning the speed URL got. Both are
  full-URL checks now, both warn when they refuse one, and there is no fallback to fall back to.
- **An endpoint that will not take the request is `rejected`, not `cut`.** A TLS alert (`handshake
  failure`, `wrong version number`, a port that is not TLS at all — the shape behind "the download
  test fails every address") used to be filed as a mid-transfer cut: the address was penalised as if
  the path had reacted to volume, and `ezscan doctor` advised lowering `--speed-bytes` after a DPI
  box that was never there. A refusal of the SYN, a reset or a silent deadline still read `cut` — on
  an address that answered a probe on the same port a moment ago, that is the DPI signature.
- **A links export refuses a template that cannot carry an address.** The rewriter answers "the
  template unchanged" when it does not understand the input, and the export took that at face
  value: an Xray/v2ray JSON document pasted into the template box produced one copy of that JSON per
  address. Proving the rewrite works is now part of the export, and failing it is an error that says
  what to paste instead.
- **Smaller, same spirit.** `POST /api/retest` obeys the single-writer rule a scan start obeys
  (409 while a scan is running, instead of re-probing a row the speed phase is writing to); the
  session-id guard rejects Windows device names (`CON`, `NUL`, `LPT1`…) that `\w` happily matches and
  Windows resolves to a device whatever the extension; `Output.table` no longer reads past the end of
  its own widths array when a row has more cells than the headers; and a check that started while
  another was still dialling no longer clears the watchdog's abort slot out from under it.

### Docs
- The README now says what the throughput column means (a verdict table, and which verdicts may
  rank), how a resume treats settings on both surfaces (CLI flags are a patch, the GUI form is what
  you see), the rule a `links` template has to satisfy, and the current counts. The repository also
  gained the issue form and pull-request template it never had — both of them ask for the `ezscan
  doctor` output first, because that is the answer to most reports.

### Tests
- 214 tests (+10). Every fix above was verified to bite: without the resume override the new test
  fails with `expected 'typed-in-the-form.example', actual 'from-the-session.example'`; without the
  re-probe fix it fails with `the speed phase is not what was retested / 0 !== 42.5`; the base64
  shadowsocks test decodes the exported link and finds `1.2.3.4` in it before the fix; and the two
  URL tests assert the warning text and the absence of a request, so a reintroduced fallback fails
  on the request count rather than on the wording.

## 1.7.2 — 2026-09-23

The speed phase exists to *order addresses by a number*, and 1.7.1 made that number stop being
reported for one shape of transfer that never happened. This release finishes the thought: the
number now carries the verdict it rests on. A throughput cell that is empty had five causes — never
tested, the endpoint refused, the path cut it, the line stalled, the endpoint stopped sending early
— and after 1.7.1 three of them still arrived as the same `failed`, while the ranking read the
emptiness as "not measured" and quietly rewarded the addresses it could tell least about. Every
measurement now carries a `SpeedTrust` (`measured`, `partial`, `cut`, `stalled`, `rejected`,
`untested`), and it is the verdict — not the number — that decides whether an address may rank.

### Fixed
- **A transfer the endpoint stops early is no longer a throughput number.** The last shape in which
a rate was reported for a transfer that never happened: `drainBytes` ended a *finished* download and
one the peer closed early as the same `close`, so a gateway that caps a response at 64 KB of the
requested 8 MB — a rate limit, a proxy enforcing a byte cap, a DPI box being politely hostile — was
read as a completed download. Reported as throughput it was a plausible number for a transfer that
did not happen, and the *best-looking* number in the scan, because the part that did arrive is the
first congestion window, where a transfer is at its fastest. The endpoint's early close now fails as
`partial` with the fraction it reached (`after 65536 bytes of 8000000 requested (0%)`) and ranks
nothing.
- **The four empty throughput cells are told apart.** A blank speed cell was five facts at once, and
only some of them are about the address — `partial`, `cut` and `stalled` are evidence the path would
not carry a payload the endpoint had agreed to send, while `rejected` (an error page, a 403 from an
edge that does not serve the speed host) and `untested` (nobody asked, or the scan was stopped) are
not. The CLI prints `!short` / `!cut` / `!stalled` / `!refused` where the number would be, the CSV
grows `down_trust`/`up_trust` (a bare `down_mbps` of `0` cannot distinguish them once it leaves the
terminal), the GUI titles the cell with the word, the OpenUI report names it, the summary line counts
the unusable tests (`3 speed tests unusable`), and the speed phase logs its refusals *counted by
cause* — twenty identical warnings bury the one thing worth reading.
- **Stopping a scan no longer blames the line.** Ctrl-C mid-transfer arrives as `abort`, which 1.7.1
folded into the cut branch — so the user's own keystroke was recorded as "something in the path
reacts to volume", the one verdict this whole tool exists to find. An aborted transfer is `untested`:
it says nothing about the path, so it neither raises nor lowers it.
- **A transfer that failed can no longer outrank one that was measured.** The speed term used to be
skipped whenever `downMbps` was 0, which is every address the speed phase did not finish with — so
"we could not find out" was the *safer* answer than "we found out, and it is slow": the row whose
transfer the path cut had the term dropped, while the row that completed a slow transfer had it
counted against it. A distrust now takes the weight with a part of 0, and `finalizeAll`'s baseline is
the fastest *trusted* download, so a number that may not rank an address cannot raise the bar for the
ones that may either. A line that cut or stalled every transfer drops the term for all of them rather
than turning a whole scan red over a fault none of these addresses caused — that is the `mobin`
preset's job.
- **A resumed session keeps the throughput it already paid for.** A snapshot written before rows
carried a verdict still holds numbers that were measured, and that the run ranked with. Restoring
them as `untested` would silently drop the speed column from every row the session had already
measured — and, with the rule above, re-score the whole restored batch. `adoptSnapshotTrust` reads an
old row the way it was read when it was written.
- **`ezscan doctor` and the ranking can no longer disagree about a transfer.** The signature carried
its own `stale`/`cut` booleans beside the scan's `SpeedTrust`, so the two could name different things
about the same bytes; `LineSignature.transfer.trust` is now the same value a scan row reads. Each
verdict also gets its own advice instead of one `failed` hint — a stall is the MTU/PMTU hole the
`mobin` preset is built around, a cut is something reacting to volume (fewer bytes, or `--no-speed`),
a short stream is a byte cap on the endpoint, and a refusal is a request that does not belong on that
endpoint at all.

### Tests
- 204 tests (+7). `drainBytes`'s endings are still pinned at the TCP level; what is new is that every
ending is pinned to the verdict it produces. Treating an early close as a completed transfer fails
`an endpoint that ends the stream early is not a throughput number either` with
**`a short transfer must not be a measurement (mbps=591.66)`** — a rate limit on loopback out-ranking
every real address, which is the whole bug in one number. Scoring a distrust the old way fails with
`a cut transfer (90) must not beat a measured slow one (82)`. The batch with nothing measured is
pinned separately: a stalled line still reports every address as reachable, it just makes no speed
claim about any of them.

## 1.7.1 — 2026-09-22

A review pass over the whole tree, and every entry below came out of running the code rather than
reading it. The two that matter most are both about a number or a setting that *looked* applied:
the resume flow shipped in 1.7.0 reset the session it was resuming (the documented
`ezscan resume <id> --speed --top 30` probed with **no SNI**), and the speed phase counted a
transfer the line had cut in half as the throughput of whatever bytes had made it. The other two
are a sampler that only ever reached one corner of a /32, and session ids that were paths.

### Fixed
- **A resumed run keeps the session's own settings.** `resume` built a *whole* config from the
  defaults and handed it to the scanner as an override, so every field the flags did not name was
  reset to its default on the way in: resuming with `--speed --top 30` — the command `docs/USAGE.md`
  documents — ran with `sni=` (nothing to serve), 50 workers instead of the session's 12, and no
  rate limit, on a session whose settings were half the reason to resume it. The flags are now a
  *patch* applied on top of the config the session was saved with (the same way the GUI's preset
  buttons have always worked), so a resume is the same scan continued. Flags that are not config at
  all (`--quiet`, `--no-color`, `--print 50`) also stop counting as "the user changed the settings"
  — under a full-config override, any of them triggered the reset.
- **A transfer the line cuts is no longer reported as throughput.** `drainBytes` described a
  transferred byte count and one boolean for "we stopped before the deadline", which is a
  *finished* stream and a *cut* one at once: a socket error mid-download was read exactly like a
  complete one, so the endpoint promising 400 KB, the line resetting after 64 KB, and the 64 KB
  that made it became **4.29 Mbps** — a number for a transfer that never arrived, in the phase the
  whole scan exists for (`--speed`, `--top`). The quiet half of that shape (a stall) was caught in
  1.6.x; this is the loud half, which is what a DPI/NAT box does when it reacts to volume. The
  read now ends as `target` / `close` / `error` / `timeout` / `abort`, a cut fails with the bytes it
  reached and the socket's own message, and `ezscan doctor` names it instead of blaming the speed
  URL.
- **A huge pool is sampled over the whole pool, not from one corner of it.** The sampler reduced a
  fixed 53-bit draw with `% size`, which is uniform only while the pool fits in 53 bits. A
  Cloudflare v6 range is a /32, so `(53-bit draw) % 2^96` is the draw itself: every "random"
  address in it came from the first 2^53 of the space — measured, the highest offset ever drawn from
  `2606:4700::/32` was **2^50 of 2^96**. The comment above the Cloudflare pools promises a uniform
  sweep over the announced space, which was true for the v4 ranges only. Rejection sampling draws at
  the pool's own width now, and the list stays exactly as reproducible from its seed.
- **The session endpoints take an id, never a path.** `loadSnapshot` accepts a path on purpose —
  `ezscan resume ./file.json` is a documented feature — and the HTTP API passed a request body's
  `id` straight into it, so anyone holding the per-run token could make `sessions/export` read any
  file the server can open and `sessions/delete` unlink any `.json` beside the data folder. An
  imported snapshot's own `id` chose its filename the same way, which is a write, not a read. The
  endpoints now require an id (a UUID, or a name an import may carry), and fall back to a fresh id
  when an imported file names something that is not one.

### Tests
- 197 tests (+5). Each fix was verified to bite: restoring the full-config override fails the resume
  test with `expected 'keep.example', actual ''`; the old 53-bit draw fails the sampling test with
  `highest offset drawn: 2^50`; reporting a socket error as a close fails `drainBytes`'s contract
  test; counting the cut transfer as a measurement fails with `mbps=4.29`; and removing the id guard
  fails `/api/sessions/load must refuse a path`. `drainBytes`'s three endings are pinned at the TCP
  level (target reached, peer closed early, path reset) so the verdict never has to guess.

## 1.7.0 — 2026-09-22

The doctor could already read a line and name the preset it needs, and the scan then ignored the
name until the user retyped it — so the flow the doctor exists for (`doctor`, then scan the line it
just diagnosed) ran `standard` on a line the tool had already measured. A scan now applies that
measurement itself and says so. Testing it turned up two defects the measurement had been hiding,
both older than this release: the retry gap and the recovery pass **never reached the scanner at
all** (`sanitizeConfig`, the funnel every surface goes through, had no branch for either field, so
the three operator presets' spacing and their second chance were dropped on the floor), and a
finished CLI scan **sat for ~4 seconds** before the process exited, because two timeouts outlived
the connections they belonged to.

### Added
- **A scan applies the preset the last `doctor` run measured.** The measurement is written next to
  the saved sessions when the doctor takes it, and read back by the next scan: the flags the run
  actually uses are the measured ones, and the line above the run says which and why. It expires
  after 12 hours on purpose — an operator's throttling is a property of the hour, not of the
  address, and a day-old verdict steering `--workers`/`--rate` would be the guesswork the
  measurement exists to remove. Past the window the scan names the command that refreshes it
  (`ezscan doctor`) rather than applying it silently, and withholds the reading. An explicit
  `--preset` always wins, and `--no-adapt` uses the flags exactly as typed. A measurement that named
  no preset is still a measurement — "nothing operator-specific here" — but it is applied silently,
  since `standard` is what the scan would have used anyway.
- **The GUI's recommendation is now an action.** The doctor banner already named the preset; it now
  carries a button that applies it through the same path the preset buttons use, so the reading and
  the settings are one click apart instead of two.

### Fixed
- **The retry gap and the recovery pass reach the scanner.** `sanitizeConfig` is the one funnel
  every surface goes through — CLI flags, the presets, the GUI's `/api/config` and `/api/preset`, a
  resumed session's overrides — and `betweenTriesMs` and `recoveryPass` were the only two
  `ScanConfig` fields without a branch in it. Consequences: the operator presets' 150–350ms spacing
  never applied, the recovery pass that 1.6.0 announced never ran from the CLI or the GUI at all
  (`recoveryPass` defaults to `false`), `--retry-gap` was inert, and `--no-recovery` switched off
  something that was already off. A gate now walks `DEFAULT_CONFIG` and fails on any field with no
  branch here, so the next one cannot repeat it.
- **A scan exits as soon as it is done.** A short run printed its results and then took another
  ~4.2 seconds to return to the shell (against 0.17s now). Two leaks: a *failed* `tcpConnect`/
  `tlsConnect` cleared its timeout only on the success path, so every refused, reset or aborted
  dial held the event loop open for the rest of its timeout; and the line watchdog armed a fresh
  interval timer *after* its `await`, undoing the `stop()` that had already run — while being
  unable to cancel a canary dial that was still waiting for an answer. On a line where the first
  canary never answers (Irancell/MCI, and fiber ONUs with the same block) that was the normal case,
  not an edge one.

### Tests
- 192 tests (+26). The new ones pin the stored measurement and the adoption rule as a pure
  function (its 12-hour window inclusive at the edge, a clock that ran backwards read as fresh,
  `--no-adapt`, an explicit `--preset`, a corrupt or hand-edited file read as no measurement), the
  scan actually *running* with the adopted preset (read back from the saved session, not from a
  printed line), the config-field gate, and the two timer leaks from both inside the process
  (`getActiveResourcesInfo`) and from outside it (a child that opens one failing connection and has
  to exit). Each fix was verified to bite: removing the timer clear fails three of them, removing
  the watchdog's re-check and its abort fails the round-trip test, renaming a `patch.<field>` fails
  the gate and both behavioural tests, and dropping the window check fails the two stale ones.

## 1.6.1 — 2026-09-22

A review pass over the whole tree, and every entry below came out of asking the code to prove what
it claims rather than reading it. The two that matter most were both in `ezscan doctor`, the tool
whose entire job is to tell a broken line from a broken scanner: it reported **`DNS lookup: ok`**
on a line where the resolver answered nothing at all, and it named a **concurrency cap** on a line
where its own control row showed that not one probe completed even with nothing else open. The rest
is a recovery pass that only ever retried the first 300 addresses it had noted, retries that
ignored the scan's own rate limit, a documented `--no-speed` that reached only `resume`, a GUI that
died a tick after printing its URL on a machine without a browser helper, and two smaller reporting
inaccuracies.

### Fixed
- **`ezscan doctor` no longer reports a dead resolver as "ok".** `defaultResolve` reports "could not
  resolve" by returning `[]`, so the row keyed on `answers.length` was unreachable: the check said
  `DNS lookup — ok: cloudflare.com → no answer` while every domain source was probing nothing. The
  verdict is now judged on whether any probe name answered, with its own hint (scan by IP — an SNI
  is never resolved), and the DoH row stops claiming an answer "is being tampered with" when the
  system resolver said nothing at all: a failing lookup and a rewritten answer are different
  problems with different fixes.
- **A failed control disqualifies the line signature.** "The probes failed while the burst was held"
  is only evidence of a *cap* if the same probes complete with nothing else open. Measured on a
  filtered line (0 of 4 idle probes completed, 5 of 6 under load), the verdict was still "the line
  caps how many sessions you may hold at once … `--workers` is the lever" — pointing the user at a
  parameter when the path was not carrying the request at all. The idle probes are now a real
  control: when none of them completes and none was reset, no preset is named, the reason says why,
  and both the CLI and the GUI print that note instead of dropping it (a recommendation with no
  preset was previously filtered out of the report entirely).
- **The recovery pass retries every address the line turned away, not the first 300.** Its
  candidates came from the diagnostic failure list, which is capped at `FAILURE_SAMPLE_LIMIT` (300)
  to keep samples small — so a bad window wider than that left everything past the 300th address
  lost until the next scan (at the presets' ~11 addresses/s a one-minute block covers over 600). The
  candidates now have their own list, and the retries **obey the scan's rate limit**: a pass that
  ignored `--rate` would hand the line exactly the burst the chosen preset exists to avoid, and get
  its own retries refused.
- **`--no-speed` works on `scan`, not only on `resume`.** `docs/USAGE.md` documents
  `ezscan scan --preset mobin --count 5000 --no-speed …` as the way to leave the speed phase out on
  a line with a broken PMTU; a scan ignored the flag and ran the phase anyway.
- **Boolean options can no longer eat the next argument.** `--all`, `--no-speed` and `--version`
  were read through `flags.has()` but not registered as boolean, so the parser treated them as
  "takes a value": `ezscan resume --no-speed a1b2c3d4` consumed the session id and printed the usage
  text. Both flags are documented in `--help` now, and a static check keeps the list in step with
  every `flags.has()` in the parser.
- **`ezscan gui` survives a machine with no browser helper.** The helper is spawned detached, so a
  missing one fails *asynchronously*: `spawn` emits `error`, and an unhandled `error` event is
  thrown. The process died a tick after printing the URL — the server was up, the browser was not,
  and a headless Linux box (where the GUI is most useful) has no `xdg-open`. The opener now lives in
  `src/cli/openbrowser.ts` with its failure contained and tested.
- **The recovery flag reaches the exports.** `recovered` ("found on the second chance, after the
  line blocked part of the sweep") was set on the result and read by nothing but tests — the CSV and
  XLSX columns now carry it, appended so nothing that parses the existing columns breaks.
- **`--print` counts the rows it actually hid.** The table shows the healthy rows when there are
  any, so the "… N more rows" line reported rows that were never going to be printed.

### Tests
- 166 tests. The new ones pin the two `doctor` verdicts as pure functions (`judgeDns`,
  `classifyLine` with a failing control), the recovery pass's candidate list separately from the
  diagnostic sample (400 turned-away addresses on ten fake lines, which the 300 cap used to truncate
  to exactly 300), the CLI's boolean-flag registry, `--no-speed` on a real local scan, the browser
  opener's contained failure, and the `recovered` column. Each one was verified by breaking the fix
  it covers and watching that test fail.
- One **flaky test made deterministic** while reviewing: the reset/back-off case needs both tails of
  a 15%-success coin, and twelve addresses gave neither (P(not one address lost every try) ≈ 8.5e-4 —
  how it failed in CI: "a reset is reported as a reset … saw: " with an empty breakdown, because
  every address had found a session). 24 addresses put both tails under 1e-6; 30 consecutive local
  runs of the old form reproduced the failure once and of the new form none.

## 1.6.0 — 2026-09-20

This release is about *usable* addresses. `ezscan doctor` now measures what the line does to a
burst, to repeated handshakes and to a large transfer, and names the preset that fits — so the
per-operator profiles stop being something to guess at. Those profiles also stop reporting
blocked addresses as healthy, and stop losing the addresses a block or a throttle caught
mid-sweep: measured against a line that was refusing every session, `tcp` called 40 of 40
addresses healthy where a handshake called the 11 that were real, and the same line blocked for
three seconds mid-sweep went from 13 of 40 addresses found to 37. Two smaller verdicts came out
of the same work: a transfer that stops moving is no longer reported as throughput, and a
refused handshake is no longer filed under "other".

### Changed
- **The per-operator presets probe with a TLS handshake, not a bare connect** (`mode: tcp` →
  `tls`), because on these networks a blocked or throttled path still completes the TCP
  handshake — the operator drops the payload, not the SYN. Measured against the harness line,
  while it was refusing every session: `tcp` reported **40/40 healthy**, `tls` reported the 11
  that were actually reachable. That is the difference between a list of addresses and a list of
  *usable* ones, and a handshake is what the user's tunnel needs before anything can be carried.
  `--mode tcp` stays available as the escape hatch for a line that blocks the ClientHello itself,
  with its meaning spelled out (the port answered, nothing more).
- **Retries are spaced out and the addresses the line took away are retried once it has passed.**
  Three attempts sent back to back are three sessions inside one throttle window and fail for the
  same reason: under a 4/s cap on the harness line, back-to-back retries found 4 of 24 addresses
  where 400 ms apart found 21. And a block or a throttle lasts seconds, so an address probed
  inside it lost its whole `tries` budget for a reason that had nothing to do with the address.
  The new **recovery pass** re-probes those (only `timeout`/`reset`/`refused` — an address that
  answered wrongly answers the same way again) after the sweep, with a **fresh record** so the
  outage is not charged to it as loss. Against the harness line with a 3 s block over a 4 s
  sweep: irancell 13/40 → **37/40**, mci 20/40 → **35/40**, mobin 11/40 → **40/40**. New flags:
  `--retry-gap <ms>`, `--no-recovery`; the presets ship 150–350 ms and the pass on.

### Fixed
- **A refused TLS handshake was reported as `other`.** OpenSSL failures arrive with no `code` at
  all, so the text is the only clue, and a real sweep of 60 Cloudflare edges reported
  `other: 81` for what was entirely a wrong/missing SNI. Those attempts are attributed to `tls`
  now, and the CLI's hint says what to do about it (paste your config, or set the SNI your tunnel
  uses) instead of suggesting `--mode tcp`.

### Added
- **`ezscan doctor` now measures the line's signature and names the preset for it**, so the
  per-operator presets stop being something to guess at. Three mechanisms are measured on the
  edge the SNI already resolves to, none of which needs root:
  - **How many sessions the line lets you hold.** Twelve sessions are opened at once and *held*,
    which is the only way a session table notices anything, and six real probes run on top of
    them. A session accepted by a full table completes its TCP — and even its TLS — handshake and
    then never reads the request, so a bare connect sees nothing; the probes are what time out
    (`12 sessions at once · 7 connected · 5 turned away`).
  - **Whether connections die without concurrency**, as the control: two probes on an idle line.
    Resets here mean DPI is killing them, not that the line is capped.
  - **Whether a large transfer stops moving.** The stall now has its own verdict rather than being
    read as throughput: a transfer that goes quiet for 1.5s without finishing fails with
    `the transfer stalled after N bytes (no data for Ns)`, which is the PPPoE/PMTU signature. That
    also fixes a speed phase that ranked addresses by a number produced by a stuck transfer.

  The verdict is one word — `--preset irancell` for a line that caps concurrency or new sessions
  (and the reason says which, since that is the difference between lowering `--workers` and
  lowering `--rate`), `--preset mci` for one that resets connections on its own, `--preset mobin`
  for fiber whose transfer stalls. A line with none of these is told so, and keeps `standard`.
  Both the CLI (`! This line has a signature …` plus a ready-to-paste command) and the GUI show it.

### Fixed
- **A stalled transfer is no longer reported as a slow one.** `drainBytes` hardcoded `ended: true`,
  so the deadline was indistinguishable from a completed transfer: a response that stalled 32 KB in
  reported `ok` with a real-looking Mbps, and in a scan that number then ranked addresses in the
  phase the tool exists for. It now reports which of the two happened, and how long the stream had
  been silent.

### Tests
- `test/doctor-signature.test.ts` — the classifier pinned as a pure function (stall → `mobin`,
  idle resets → `mci`, a capped burst → `irancell`, with the `--workers`/`--rate` distinction, and
  one reset staying indistinguishable from noise), plus the measurement itself driven against the
  same fake access network the presets are tested with.

  Two limits of the model, both now written down where they are relied on: a **black hole cannot
  be reproduced on loopback** (no RTT, and node's TLS layer reads at the handle level, so the
  request is already buffered by the time any handler runs and the session *is* answered), so tests
  that need the client to observe a turned-away session use a real RST instead; and a session table
  is invisible to a bare TCP connect, which is why the probes run on top of the held burst.

## 1.5.0 — 2026-09-20

Two of the fixes below came out of running the tool against a real line, and they were the
actual reason a healthy line looked like a broken scanner: the mode the CLI recommends threw
away every reachable address, and the speed phases reported error pages as transfers. The rest
is the next step for the networks this tool is written for — a preset per operator, so the
settings a given line needs are one word instead of a row of flags to remember.

### Added
- **Per-operator presets: `--preset irancell|mci|mobin`** (aliases `mtn`, `hamrah`,
  `mobinnet`), so the settings a given network needs are one word instead of a row of flags to
  remember. `irancell` and `mci` are the CGNAT shape (a cap on new sessions per second, black-
  holed SYNs, DPI resets on MCI): 12 workers, a 40–60 ms pause, `rate 10–12`, three tries, a
  6 s timeout, handshake-only. `mobin` is the cheap-PPPoE-ONU profile: a small sweep, plus a
  longer speed budget because a broken PMTU stalls a large transfer. They are also buttons in
  the GUI next to the existing presets. The numbers are not guesses —
  `test/operator-profiles.test.ts` drives its per-operator runs *through `applyPreset()`*, so
  changing a preset that a network can no longer take fails the suite.

### Fixed
- **`--mode tcp` declared every reachable address unhealthy.** The probe stops at the
  handshake in tcp mode, but scoring still demanded the HTTP status it never collected (and
  the same for the WebSocket gate and the idle hold), so each row was rejected with
  `HTTP check failed`. A real sweep of 30 Cloudflare edges — 90 ms, 0% loss, `30 reachable` —
  reported `0 healthy`, in exactly the mode the CLI recommends for a hostile line: its own
  hint says "try `--mode tcp`". The protocol gates now judge only what the probe actually
  did, which is what the CLI warning already promised.
- **The speed phases counted error pages as transfers.** `measureDownload`/`measureUpload`
  never read the HTTP status, so an error page was measured as a download: on a real line a
  Cloudflare edge answering `403 error code: 1034` (with a ~8 KB HTML body) was reported as
  `0.69 Mbps` and marked **ok**, and in a scan that number then ranked every address in the
  phase the tool exists for. Only a 2xx is a transfer now; anything else fails with the
  status (`HTTP 403`), so `ezscan doctor` shows a real number or a real reason.
- `ezscan doctor` probed a hard-coded Cloudflare address with the SNI it was testing and with
  the speed hostname, so its TLS/HTTP rows could pass against an edge that serves neither
  (`HTTP 403 … ok`) and its throughput row measured the wrong endpoint entirely. Each row now
  dials an address resolved for the name it tests, falling back to the old constant only when
  the name does not resolve.

## 1.4.0 — 2026-09-20

Release for the lines this tool exists for. The watchdog can no longer park a healthy scan
over a canary the operator blocks, `ezscan doctor` can tell a rewritten resolver apart from
a broken scanner, and the line-stability claims are now proven against a fake access
network instead of described.

### Fixed
- **The line watchdog can no longer park a healthy scan over a canary the operator
  blocks.** It watched exactly one endpoint — the configured `canaryHost`, and the default
  config sets that to `1.1.1.1` — so on IR-MCI, Irancell and plenty of fiber lines (where
  1.1.1.1 is filtered, or the ONU drops it) two failed rounds in a row marked the line down
  and the scan sat frozen at "waiting for the line to come back…" on a line that was
  perfectly fine. It now fails open: the configured canary is tried first, the built-ins
  (8.8.8.8:53, 9.9.9.9:443) stay behind it as a fallback, and a **refusal counts as an
  answer** — a RST or `ECONNREFUSED` proves the path works, so a canary that is merely
  blocked or not listening can never pause a scan. The line is called down only when no
  canary answers at all, and the message names every endpoint that got a turn. With the
  default config nothing extra is dialled (`1.1.1.1:443` is already a built-in, and the
  list is deduped); `--no-autopause` still turns parking off completely.

### Added
- **`ezscan doctor` now detects a resolver that is being rewritten.** Its DNS check used to
  pass as long as *something* came back, so on a line that answers public names with the
  operator's block-page address (`10.10.34.34` and siblings) the report said "DNS lookup
  ok" while every domain source was probing an address that was never the host's. The check
  now flags block-page answers, private/loopback/CGNAT answers for a public name and
  non-addresses, and it resolves the same name over **DNS-over-HTTPS** — connecting to
  `1.1.1.1` (`cloudflare-dns.com`) and `8.8.8.8` (`dns.google`) *by IP with their own SNI*,
  so the comparison does not depend on the resolver under test — to say what the real
  answer is. A `DNS over HTTPS` row reports agreement or tampering, an unreachable DoH
  endpoint is reported as "comparison skipped" rather than a failure, and the CLI prints a
  `DNS answers are being rewritten on this line` block with the fix (scan by IP, or change
  the resolver). `DoctorReport.dnsHijack` carries the same detail to the GUI.

### Tests
- `test/helpers/hostile-line.ts` — a fake upstream that behaves like the access network the
  scanner usually meets: a **hard session limit** (CGNAT / the ONU's conntrack table) that
  resets the sessions past it and drops the whole line for `outageMs` once it is filled,
  per-response **delay and jitter**, and an **MTU/MSS blackhole** that sends the headers and
  the first bytes of a download and then never finishes it. It counts accepted/refused
  sessions, peak concurrency, outages, resets and stalls, so a test asserts on what
  happened rather than on timing luck.
- `test/hostile-line.test.ts` — the integration proof behind the line-safety claims:
  a 20-worker burst on 24 addresses fills the table (`peakConcurrent >= 12`), drops the line
  and loses the addresses probed during the outage, while the same addresses on the same
  line are *all* found with 6 workers (peak ≤ 6, no outage, nothing refused); a 300 ms
  response delays every row red at `timeout 120` and green at `timeout 1500` with the delay
  visible in the measurement and the failure attributed to `http`/`timeout` only; a line
  resetting 85% of sessions raises `backoffFactor` above 1 and is still never dropped; and a
  black-holed 400 KB transfer is measured as slow (transfer-bounded, run finishes in
  < 8 s) while an unblocked transfer on the same addresses is far faster, with the
  addresses healthy either way.
- The **park → resume cycle is now proven, not described**: a scan is swept against the fake
  line, the line is taken down at address 6 of 60, and `test/hostile-line.test.ts` asserts the
  scan parks where it stands (state `offline`, `stats.offline`, the announced `network` event,
  the `network:` log line and the "waiting for the line to come back…" status), that the
  address list **stops being consumed** while it is down (`done` frozen across two samples,
  `inflight` back to 0, no failure charged to an address), that the watchdog keeps checking
  the line meanwhile, and that the sweep resumes **by itself** when the line returns — all 60
  addresses probed, all 60 healthy, none of them twice. A loopback line cannot be made to drop
  a SYN (a closed port answers with a RST, which this watchdog counts as proof the path is
  up), so the test replaces the canary *dial* (`NetworkWatchdog.dial`, and `Scanner` now
  accepts watchdog overrides) while the probe traffic, the session table and every result
  asserted stay real.
- `test/operator-profiles.test.ts` — the same severe test run against the three access
  networks the tool is written for, so the per-operator advice rests on numbers: **Irancell**
  (CGNAT session slot + a new-session rate cap, black-holed SYNs), **MCI / Hamrah-e Aval**
  (the same plus DPI resets) and **MobinNet fiber** (a cheap PPPoE ONU whose table, when
  filled, drops the whole home for `outageMs`). Each asserts that the brutal profile is
  *visible to the network* — the burst loses sessions to the rate cap, and on the fiber
  profile it trips the ONU table and takes the line down — and that the profile the docs
  recommend for that operator (12 workers, 40 ms pause, `rate 12`) gets the whole list with
  nothing turned away and no outage. It prints the numbers:
  `brutal: found 0/40 · peak 16 sessions · 64 turned away · 1 outages`, against
  `--preset mobin: found 40/40 · peak 2 · 0 turned away · 0 outages`.

  Two things this test had to learn the hard way, and they are worth knowing beyond the test:
  **a session table only sees sessions that are held.** A handshake-only probe hangs up the
  instant it connects, and on Linux those sockets are gone before the server gets a turn to
  accept them — the same 200-worker burst that peaked at 16 sessions on Windows peaked at **2**
  there, and the test asserting "the network must react" failed for a reason that had nothing
  to do with the network. Both runs are now driven in `http` mode (each session held until the
  delayed response arrives), which is also the harsher case: a `tcp`-mode session lives for
  milliseconds, so the shipped handshake-only presets are gentler than these numbers suggest.
  And **a rate limiter starts full.** The token bucket hands out a burst of `rate` tokens up
  front, so a preset declaring 12/s still opens ~2x that in its opening second; the line caps
  are sized above that honest opening rate, or the assertion is luck rather than headroom.
- `test/helpers/hostile-line.ts` gained `maxNewSessionsPerSec`, the per-second cap a CGNAT
  slot enforces — the mechanism that turns a burst into timeouts on a line that is otherwise
  fine, which a session *table* alone only models under sustained load.
- `test/doctor.test.ts`: the block-page/private/CGNAT/IPv6 classification and the DoH
  response parsing (Cloudflare and Google both return `Answer[].data` with the A records
  typed 1, CNAME first).
- Regression tests for the fail-open path: an unanswered canary falls through to the next,
  a refused connection keeps the line up, the watch list is ordered and deduped, and the
  line is still called down (and still resets) when nothing answers.

## 1.3.1 — 2026-09-19

Review pass over the paths the suite exercised least — source expansion, share-link parsing
and the line watchdog. Every fix below has a regression test.

### Fixed
- **A domain with a port was never resolved.** `my.host:8443` in a pasted list, a file or a
  DNS source was pushed through as the literal target `my.host:8443`, which is neither a
  hostname nor an `ip:port` pair, so every probe of it failed at DNS while the source
  reported no error at all. The host is now resolved and the port re-attached (IPv6 answers
  bracketed), and the resolver is handed the bare host.
- **An explicit `count` could not protect a large source.** The address ceiling was applied
  to the freshly built list, so a source that expanded past it (a file full of small CIDRs,
  a multi-million-line paste) failed with "target list is too large" even when the user had
  asked for `--count 5000`. The count is honoured first; the ceiling now judges the list that
  is actually returned.
- **One stray `%` in a link name made a whole config unparsable.** `decodeURIComponent` ran
  outside any guard, so `vless://…#My%20node%` came back as `cannot parse vless link: URI
  malformed` — the SNI, port and transport a scan needs were lost over a cosmetic label. The
  fragment is now decoded leniently (well-formed escapes still decode exactly as before).
- **`ezscan config` recommended a command that scanned a single address.** Its "scan with
  these settings" line was `--source config … --count 3000`, but `--source config` only
  expands the config's own server address, where a count is inert. It now recommends the
  Cloudflare sweep with your SNI/port, and names the single-address mode as what it is.
- **A new scan could inherit the previous line verdict.** The watchdog started every scan
  with whatever the last one left behind, so a scan that ended while the line was down (or
  any scan with the watchdog disabled, which never checks) showed a stale "line down" badge
  that nothing corrected. `reset()` now runs at the start of a scan, and the first check —
  which already runs immediately — decides the state again.
- `canaryHost` can be cleared again: validation fell back to the previous host on an empty
  value, so a custom canary could never be removed without restarting the process.
- The unknown-preset error listed `gentle` twice and never mentioned the `iran` alias.

### Removed
- `AdaptiveBackoff.delayMs()` (nothing called it — the scanner computes its own delay) and
  the unused `canary` watchdog option (superseded by `canaries`), plus a loop in the DNS path
  that iterated over resolved addresses to do nothing with them.

### Docs
- `docs/USAGE.md`'s "three-click path" stopped after **Use its SNI/port**, which leaves the
  Config *source* selected — a reader ended up scanning the one address inside their own
  link. It now says to switch back to the Cloudflare tab, and spells out what the Config
  source actually does. The GUI's quick help says the same, and the README's CLI examples
  mark which command sweeps the ranges and which one probes the config's own address.

### Added (gates, so the next release cannot drift)
- `test/version.test.ts`: the version literal in `package.json`, the CLI, the GUI server and
  the OpenUI report default must all agree, and each source must carry exactly one — the
  bump is manual in four files, and a release that ships one stale is a release whose
  `ezscan --version` disagrees with the GUI footer.
- `test/cli.test.ts`: the CLI is spawned the way a user runs it — `--version`, an offline
  `scan --dry-run`, the recommended `config` command and the preset error list.

### Tests
- 119 tests pass (109 before: 4 regression tests for the fixes above and 6 for the two new
  gates). `npm run typecheck` is clean.

## 1.3.0 — 2026-09-17

**English-only.** The project ships in English, and the GUI still carried a whole FA/EN
layer: two string tables, a language switch, Persian digits and dates, and a self-hosted
Persian webfont. All of it is deleted rather than left half-wired, and two new gates keep it
gone.

### Removed (the FA half of the GUI)
- `app.js`: the `EN` key table (static strings the markup asked for), the `RT.fa` runtime
table, the `FA` DOM-scrape map, `initI18n()`, `setLang()` and the `lang` global. The English
runtime table is now `T`, and `num()`/`share()`/`dec()` no longer branch on locale (no
`fa-IR` digits, no Persian percent sign).
- `index.html`: every `data-i18n`/`data-i18n-ph` attribute and the language button, so the
markup carries its own English text; the document is now `lang="en" dir="ltr"`.
- `core/openui.ts`: the Persian words table and the `language` input; `server.ts` no longer
reads a `lang` query parameter, so the report builder emits one document.
- `report.html`: its Persian text table, the `lang` parameter and the RTL font rules.
- `src/gui/fonts/` (Vazirmatn, four weights plus its OFL licence) and the four `@font-face`
blocks: an English-only UI renders with the platform font stack and ships zero font bytes.
- The RTL-only rules (`:root[dir='rtl']`), including the mirrored progress gradient.

### Changed
- GUI font stack: `system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
(was Vazirmatn plus Tahoma).
- Version 1.3.0 in `package.json`, the CLI, the server and the report default.

### Docs
- `README.md` rewritten in English, `docs/USAGE.fa.md` replaced by `docs/USAGE.md`, and the
Persian issue titles in `docs/ISSUES.md` translated (issue numbers and findings unchanged).

### Added (gates, so it cannot rot back)
- `test/gui.test.ts`: the GUI is English-only - no character from the Persian/Arabic script
and no `data-i18n`, `dir="rtl"` or `lang="fa"` marker may appear in the four GUI files.
- `test/deadcode.test.ts`: a project-wide sweep over `src/`, `test/`, `scripts/`, `docs/`,
`README.md`, `CHANGELOG.md` and `package.json` fails the build on any non-English text.
- The translation-parity gates (EN key coverage, FA/EN table parity) are gone with the
tables they guarded; the runtime-string gate now walks the single `T` table.

### Fixed (accounting and line-watchdog bugs, found in the full-project review)
- **Resuming a session no longer restarts the counter at 0.** The probe phase kept its own
counter, so a 90 %-done session reported 10 % done after a resume — and the progress bar,
rate and ETA all followed it. The counter now continues from the snapshot.
- **A stop neither fails nor consumes the addresses still in flight.** An aborted probe used
to be recorded as a failure (poisoning `failuresByKind` and the snapshot) while its index
stayed consumed, so a resume silently skipped those addresses. The cursor is now rewound to
the earliest unfinished address.
- The cursor can no longer run past the end of the target list (it overshot by up to
`workers`, which is the same bug seen from the other side).
- **`--canary host:port` now carries the port**, and a configured canary reaches the
watchdog at all: it used to be frozen into the watchdog at construction time (so neither
the flag nor the setting had any effect) and was *appended* to the three built-in canaries
rather than replacing them — on a line that blocks 1.1.1.1/8.8.8.8/9.9.9.9, a healthy scan
parked forever. `canaries` is now reported in the network state so a parked scan says which
endpoints it is waiting for. The watchdog also checks once immediately on start instead of
waiting a whole interval.
- Sorting the results table by `up` actually sorts by upload speed (it silently fell back to
score, with the aria-sort state claiming otherwise).
- Removed three fields that promised data nobody could read: `handshakeMs` (a copy of
`medianLatency` with a different name) and `ttfbMs` on results, and the `speedPending`
counter that was set once and never cleared or shown.

### Added
- `test/ratelimit.test.ts` (4 tests) for the token bucket, the adaptive backoff and the
canary rules, plus regression tests for the resume counter (`progress restarted at …`) and
for a stop landing mid-probe.
- **Automated releases.** `.github/workflows/release.yml` verifies the tag (typecheck, gates,
tests), packages the tracked files with `git archive`, writes `SHA256SUMS.txt`, extracts the
notes from `CHANGELOG.md` (`npm run notes -- 1.3.0`) and publishes the release. Every
release before this one was assembled by hand.

### Tests
- 109 tests pass (100 before this review pass: 5 for the accounting/watchdog fixes and 4 for
the release tooling). `npm run typecheck` is clean and `npm run check:deadcode` runs the
non-English gate in CI.

## 1.2.0 — 2026-09-16

GUI rebuild. The old screen was a form, then a table, then some panels; it is now a
single operations console with a fixed information order — setup rail, live console,
results, dock.

### Changed (visual system)
- Design direction taken from the
  [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) generator for
  a *real-time operations dashboard* in the *Dark Mode (OLED)* style: its palette
  (`#0F172A` background, `#1B2336` card, `#1E293B` primary, `#272F42` muted, `#22C55E`
  accent, `#EF4444` destructive), a dense 8/12/16/32 scale and a single restrained
  effect (a low-emission glow spent only on live status).
- Persian type is now real type: **Vazirmatn** (SIL OFL) is self-hosted in
  `src/gui/fonts/` with four weights — still no CDN, still works offline on a filtered
  line. Latin stays on the system monospace stack, with tabular numerals everywhere a
  number can change.
- The whole shell is RTL-first with logical properties (`margin-inline`, `inset-inline`)
  and mirrors correctly for `lang=en`; the light theme is kept (the generated style says
  "light not recommended") because the tool also gets used on projectors, and both themes
  are checked for 4.5:1 text contrast.
- Icons are one SVG sprite (no emoji), every icon-only button carries a label and a
  tooltip, the two tablists (`address source`, dock) support arrow keys with a roving
  tabindex, focus rings are always visible, and `prefers-reduced-motion` disables motion.

### Added (function, not paint)
- **KPI strip** with checked/answered/no-answer/clean/rate/ETA plus per-share percentages —
  the six numbers people were previously reconstructing from one long log line.
- **Live / stale / disconnected indicator** driven by the actual SSE heartbeat, with a
  tooltip saying when the last message arrived, and a **pause live updates** switch that
  keeps collecting without repainting (buffered count shown).
- **Localised rejection reasons**: the scoring module's machine strings
  (`no successful attempt (timeout ×2)`, `loss 60% > 50%`, …) and the scanner's status
  messages are now rendered in the UI language, with the raw string kept in the tooltip.
- Lower **dock** with four tabs — live log, OpenUI dashboard, export & config, tools —
  instead of six stacked panels, and a skeleton/empty state that distinguishes "nothing
  found yet" from "your filter hides everything".

### Changed (payload)
- The vendored OpenUI stylesheet is **pruned to the components the report renders**
  instead of shipped whole: 310.0 KB → 102.2 KB raw and 33.3 KB → 9.1 KB gzipped
  (1837 → 448 selector rules, 32 of 37 keyframes dropped). Upstream ships one sheet for its whole
  product — chat, agent pane, artifact browser, model switcher, accordions, date pickers —
  none of which the report iframe can render, yet the browser parsed and indexed every one
  of those rules. `scripts/prune-openui-css.ts` regenerates it from the pinned upstream
  file; the rules it keeps are chosen by *class family* (`.openui-callout` keeps
  `-warning`/`-danger`), element/`:root`/custom-property rules and every non-`openui-`
  class (`.recharts-*`, `.lucide`) are kept unconditionally, source order is preserved
  (so `@media` overrides still win), and the generated `PRUNE-REPORT.md` records the
  before/after sizes and what was dropped.
- `report.html`'s stylesheet `?v=` pin is now derived from the content hash
  (`?v=0.1.4-p…`) and rewritten by the prune script. It used to stay `?v=0.1.4` while the
  file changed, and because the server caches a pinned URL for a week, a browser that had
  already loaded the unpruned file would keep serving it.

### Fixed
- The setup rail's sticky header was pinned inside the rail itself below 1180px, which
  pushed it down by its own inset and left a ~48px dead gap at the top of the panel.
- `#stat-line2` and the old status badge were replaced by the KPI strip and the state
  pill; the footer summary and the progress tooltip now agree with the server totals.

### Removed (dead export surface)
- 29 exported types that no other file imported lost their `export` (they are still used
  inside their own module): the option/result interfaces of `render`, `export`, `net`,
  `ipsrc`, `probe`, `ratelimit`, `scanner`, `configparse`, `validate`, `zip`, `doctor`,
  `openui`, `events` and `server`, plus `scoring.ScoreParts` and `types.SourceKind`.
- Two runtime strings (`no`) that nothing rendered.

### Tests
- New `test/deadcode.test.ts` (3 tests) is the permanent version of the throwaway audit
  scripts the 1.1.1 cleanup used: it fails when an exported symbol is used only inside
  its own module, when a design token is defined but never read with `var()`, or when an
  EN/RT translation key has no reader. A dedicated `npm run check:deadcode` step runs it
  first in CI so the failure is obvious in the job list.
- New `test/gui.test.ts` (12 tests) enforces the contract between the three build-free GUI
  files: every id `app.js` selects exists in the markup, every source tab has exactly one
  block, every icon reference resolves to a sprite symbol, every `data-i18n` and
  placeholder key has an EN translation, the FA/EN runtime tables have identical keys,
  every scanner phase, probe error kind, rejection reason and status message has a
  translator, both themes theme the same colours, classes used in the markup exist in the
  stylesheet, and no asset is loaded from a CDN.
- New `test/openui-css.test.ts` (7 tests) keeps the prune honest: the committed stylesheet
  must be *minimal* (a second run drops nothing, so a half-pruned file cannot pass),
  *complete* (all 85 styled classes the report renders — captured from a real report DOM
  into `test/fixtures/openui-report-classes.txt` — still have rules, and every component
  `src/core/openui.ts` can emit across five scan scenarios is mapped to a class family, so
  a new component cannot quietly lose its styling), *within its size budget*, and *fresh*
  (the `?v=` pin matches the file). A dedicated `npm run check:openui-css` step runs it in
  CI alongside `check:deadcode`.

## 1.1.1 — 2026-09-16

Cleanup and performance pass after the OpenUI work.

### Removed (dead code)
- `throttle()` (event emitter), `isHealthy()` (scoring) and `describeWarnings()`
  (validation) were never called — deleted instead of documented.
- 13 helpers that were exported but only used inside their own module no longer widen
  the public surface (`toJson`, `toNdjson`, `formatAddress`, `isIp`, `isIpLiteral`,
  `scoreParts`, `mapError`, `b64decode`, `healthTag`, `loadExtraRanges`, `BROWSER_UA`,
  `CLOUDFLARE_V6`, `EXTENDED_DEFAULT`).
- 10 unused design tokens and the unused `source-tabs` id; stale `.gitignore` entries
  for files this project never creates.
- `medianOf()` in the report builder duplicated `median()` from the scoring module.

### Performance
- The OpenUI renderer bundle (~3.5 MB) is no longer fetched on GUI startup: the report
  is mounted on demand — when the dashboard scrolls into view *and* a scan has produced
  data, when the user clicks it, or when a scan starts. Fresh installs never pay for it.
- Static files are served gzip-compressed with a cached, mtime-invalidated buffer
  (bundle 3.62 MB → 0.99 MB, own CSS 24 KB → 4 KB), and version-pinned assets
  (`?v=`) are cached for a week.

### Fixed
- The footer summary now uses the server's totals instead of the (possibly truncated)
  client-side list, so large scans are counted correctly.
- `report.html` rendered once before the deferred renderer bundle had executed, which
  made it fall back to "bundle did not load" on the first paint.

## 1.1.0 — 2026-09-16

### GUI — OpenUI dashboard
- New **OpenUI dashboard** panel: the scan is turned into an [OpenUI
  Lang](https://github.com/thesysdev/openui) document (`src/core/openui.ts`) and rendered
  with OpenUI's official renderer + component library, so a result set becomes KPI cards,
  a latency histogram, a cleanest-addresses table, the active gates and a failure
  breakdown instead of a bare table.
- `GET /api/report/openui?lang=fa|en&top=25[&download=1]` serves that document;
  `src/gui/report.html` renders it in an iframe (style-isolated) with refresh, new-tab,
  copy and download buttons.
- The renderer (`@openuidev/browser-bundle@0.1.4`, MIT) is **vendored** in
  `src/gui/vendor/openui/`, so nothing is fetched from a CDN — the GUI still works on
  lines where jsDelivr/unpkg are blocked.
- Report text is available in Persian or English and follows the GUI language.

### GUI — look and feel
- The whole UI was re-skinned on **OpenUI's design tokens** (oklch palette, spacing scale,
  radii, type ramp, shadows) with a light and a dark theme, a manual theme switch that is
  remembered, logical (RTL-safe) properties, focus rings and reduced-motion support.

### Tests
- `test/openui.test.ts` validates the generated OpenUI Lang: one statement per line, no
  undefined or duplicated identifiers, balanced brackets, only components from the
  official chat library, equal-length table columns, numeric-only chart series, string
  escaping and determinism. 68 → 78 tests.

## 1.0.0 — 2026-09-16

First release: a complete re-implementation of the clean-IP discovery workflow,
built so that the failure modes reported against other scanners cannot happen
silently.

### Engine
- Probe pipeline with independently switchable gates: TCP connect → TLS handshake
  → HTTP/1.1 response validation → WebSocket upgrade → idle-hold DPI check.
- `requireWs` and the idle hold are **off by default** (they caused "everything is
  red" reports elsewhere); both are one click / one flag away.
- Explicit `tries` / `minSuccesses` instead of an implicit "must pass everything",
  with `earlyExit` to cut scan time by ~2–3×.
- Scoring (0–100) from latency, loss, DPI survival, HTTP validity and throughput;
  every rejection records a human-readable reason and a machine-readable error kind.
- Bounded failure samples + aggregate failure breakdown, so "why is it red?" is
  answerable instead of a mystery.

### Sources
- Official Cloudflare IPv4/IPv6 ranges with seeded, size-proportional sampling.
- Paste text, file, CIDR, `a-b` ranges, `ip:port`, `[v6]:port`, domain names,
  optional extended (non-official) prefixes.
- Share-link parsing (`vless`, `trojan`, `vmess`, `ss`, `hysteria2`, `tuic`) and
  Xray/sing-box JSON, including SNI/host/path extraction and a "scan my config's
  domain" mode.

### GUI
- Local server on loopback (per-run token, same-origin + DNS-rebinding guards) and a
  dependency-free RTL/LTR web UI: presets, all probe/speed/safety settings, live
  progress with failure breakdown, sortable result table, bulk actions,
  "scan only these", exports, config builder, session manager, doctor panel, live log.
- FA/EN switch, colour-independent status indicators.

### CLI
- `gui`, `scan`, `resume`, `sessions`, `export`, `doctor`, `selftest`, `config`.
- Full scan option surface, `--preset fast|standard|strict|gentle`, dry-run source
  preview, file exports, failure breakdown with actionable advice.

### Output
- TXT (`ip:port`, IPv6 bracketed), IPs-only, CSV (Excel BOM, 20 columns), real XLSX
  via a dependency-free ZIP/CRC32 writer, JSON, NDJSON, and ready-to-import share
  links built from the user's own config template.

### Reliability & safety
- Global token-bucket rate limit, per-worker delay, adaptive back-off driven by an
  EWMA of failures.
- Network watchdog with three canaries that parks a scan when the line dies and
  resumes automatically.
- Resumable sessions: snapshot every 15 s plus on stop/finish/abort, resume with
  config overrides, import/export session files.

### Testing
- 68 tests: IPv4/IPv6 math, CIDR/range/paste/domain expansion, gate-by-gate scoring,
  link parsing and rewriting, CSV/XLSX/ZIP integrity, config sanitising, probe
  behaviour against a local TLS/WS/dying/garbage edge, pause/resume/stop/resume
  semantics, and the full HTTP API including its security guards.
