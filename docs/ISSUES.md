# Issue map — what EZ Scanner does about the reported problems

The reference project (`MatinSenPai/SenPaiScanner`) has ~40 open issues. Below is
every issue that is still open, what the actual root cause was (read from the
source and reproduced locally), and how EZ Scanner handles it.

Legend: **fixed** = solved by design, **avoided** = the design change makes the
class of problem impossible, **n/a** = does not apply to this implementation.

---

## "Nothing is green" family — the highest-impact group

### #131 "practically useless" / #66 "no IPs are found" / #102 "the IP test is broken"
**Cause.** Three strict gates were on by default: WebSocket upgrade
(`RequireWS`), a 1.5 s idle hold (`probeStability`) and "≥2 successful tries **and**
loss < 50 %" — plus the speed-test path was called with `Tries: 1`, which can never
satisfy a "≥2 successes" rule, so every row printed `download sample failed`.

**EZ Scanner.**
- WebSocket and idle hold are **off by default** (`requireWs: false`, `stabilityMs: 0`)
  and every gate is spelled out in the GUI/CLI.
- Verdicts are computed by pure functions in `core/scoring.ts` with an explicit
  `minSuccesses` (default 2 of 3) — never an invisible "must pass everything".
- A single attempt can be healthy (`tries: 1, minSuccesses: 1`), which is exactly
  the mode the old speed test needed. Covered by
  `test/scoring.test.ts → "a single attempt (early exit) can still be healthy"`.
- Every rejection carries a machine-readable reason (`loss 67% > 50%`,
  `WebSocket upgrade failed`, …) shown in the table tooltip, the CSV and the CLI.

### #56 "no IPs found on MCI" / #58 "Shatel and Irancell" / #75 "the scanner hangs"
**Cause.** A dead address costs up to 3×4 requests with a 2 s dial timeout (~24–48 s)
because the SNI fallback loop ran per attempt; with the GUI defaults (5 000 IPs,
50 workers, 5 s timeout) the first green row could take half an hour. On throttled
lines the scan also looked frozen.

**EZ Scanner.**
- `earlyExit` (default on) stops probing an address the moment `minSuccesses` is
  reached — typically 1–2 attempts instead of 3–4.
- Failures are cheap: one attempt per address in `tcp` mode, and the default
  timeout is 4 s with an explicit worker pool.
- Live progress (phase, %, rate, ETA, in-flight, failure breakdown) is streamed to
  the GUI over SSE every 500 ms and to the CLI every tick, so a slow scan is never
  silent.
- The **gentle** preset exists precisely for MCI/Shatel/Irancell lines: 2 tries,
  1 required success, 20 workers, 12 connections/s, 40 ms delay.
- The per-operator presets add two things this complaint needs: retries are **spaced**
  (`--retry-gap`, 150–350 ms) instead of landing in the same throttle window, and a
  **recovery pass** re-probes the addresses the line turned away once the window has passed,
  with a fresh record so an outage is not charged to the address. Same line, blocked for 3 s
  mid-sweep: **13/40 → 37/40** addresses found (see `test/recovery-pass.test.ts`).

---

## Feature requests

### #130 "save an unfinished scan and continue it" + #64 "stop and resume mid-scan"
**EZ Scanner.** `core/scanner.ts` snapshots the whole session (config, ordered
target list, cursor, results, failure samples, logs) to
`~/.ez-scanner/sessions/<id>.json` every 15 s and on pause/stop/finish/abort. The
CLI resumes with `ezscan resume <id>` (optionally overriding config, e.g. adding
`--speed`), the GUI has resume/download/delete/import-session controls. Tests:
`test/scanner.test.ts → stop … resumable snapshot`, `… resumes from its cursor`.

### #113 "paste custom domains and ranges" + "start the scan at phase 2"
**EZ Scanner.**
- Sources: official Cloudflare ranges, pasted text, a file picker (read in the
  browser, no path juggling), domain lists, and the domain of your own config link.
- The pasted grammar accepts `ip`, `ip:port`, `[v6]:port`, `CIDR`, `a-b` ranges,
  domains, `#`/`//`/`;` comments and comma/whitespace separation
  (`core/ipsrc.ts`, `test/ipsrc.test.ts`).
- "Scan only these" re-runs a scan on the selected/bulk rows, so a second phase on
  your own list is one click (CLI: `--source paste --targets my-ips.txt`).

### #110 "combine IPs with a config" + #106 "Excel/CSV" + #44/#90 "copy in PuTTY/Termux"
**EZ Scanner.** Paste your link once, then:
- **Copy configs** → one ready-to-import link per address, labelled
  `EZ-<ip>-<latency>ms-<mbps>M`;
- **Download configs** → the same list as a file;
- CSV (with Excel BOM), **real XLSX written by a dependency-free ZIP writer**,
  JSON, NDJSON, `ip:port`, IPs-only;
- a one-click clipboard copy in the GUI, so no terminal clipboard manager is
  needed (this is the #44/#90 complaint).
`test/export.test.ts`, `test/configparse.test.ts`.

### #97 "sni" (and BPB `FAKE_SNI` / `CONNECT_IP` workflows)
**EZ Scanner.** A first-class SNI field, an SNI rotation pool (one SNI per attempt
— useful when a specific hostname is throttled), automatic extraction from
`vless://`, `trojan://`, `vmess://`, `ss://` and Xray/sing-box JSON, and a
`--sni-mode`-style workflow: scan with a generic SNI such as
`www.cloudflare.com`, then inject the discovered addresses into your own config
with the config builder.

### #104 «dedicated local desktop GUI»
**EZ Scanner** ships the GUI as a first-class feature: a local server on
`127.0.0.1` (loopback only, per-run token, cross-origin rejected, DNS-rebinding
guard) plus a dependency-free RTL/LTR HTML UI. No WebView2 runtime, no
`cmd/gui` that has to compile.

### #129 "go install does not work" / #114 "how to run on linux?" / #111 "32-bit"
**EZ Scanner** is a Node program: `npm install -g .` or `git clone && npm start`.
Same code path on Windows, Linux, macOS, 32/64-bit and Termux. No bootstrap
problem, no `http2.TrailerPrefix` style build break, no per-architecture binary.

### #126 "crash on Android", #39-style WebView issues
**n/a** — the UI is a web page; if a browser opens the URL, the app runs. Nothing
to crash in a WebView or an APK.

### #51 "linux cli colour / colour-blind" — accessibility
**EZ Scanner** never encodes state in colour alone: CLI rows carry
`[OK]`/`[--]`/`[!!]`, the log lines carry `ok`/`**`/`!!`, colour is optional
(`--no-color`, `NO_COLOR`, non-TTY) and the GUI is a normal accessible document
with labels for every field.

---

## Anti-detection / line stability

### #25 "the line drops while scanning" / #62 "the operator detects the scan" / #96 "the connection dies after a scan"
**Cause.** A burst of thousands of parallel TLS handshakes from one line is a
textbook scan signature; the operator (or an ISP-level DPI) reacts by dropping the
line until the router restarts.

**EZ Scanner** addresses this with three independent controls:
1. global token-bucket rate limit (`rateLimitPerSec`) + per-worker delay;
2. adaptive back-off: an EWMA of the failure ratio raises the inter-probe delay
   automatically when resets/timeouts spike, and relaxes it when the line calms —
   `test/hostile-line.test.ts` proves it on a line that resets 85 % of sessions;
3. a network watchdog that TCP-checks canaries (your own first, then 1.1.1.1:443,
   8.8.8.8:53, 9.9.9.9:443 behind it) — when the line dies the scan **parks** instead of
   hammering a dead link, and resumes automatically when it comes back (`core/ratelimit.ts`,
   surfaced in the GUI as the "line: DOWN" banner). The whole cycle — parked, reported, then
   finishing the list on its own with no address lost — is driven end to end in
   `test/hostile-line.test.ts` by taking the line down at address 6 of 60. The whole set is exercised against a
   fake session-limited access network in `test/hostile-line.test.ts`: a 20-worker burst
   fills the session table, resets the sessions past it and drops the line, while the same
   addresses under a worker budget that fits are all found. It fails open, which matters on
   IR-MCI/Irancell/fiber lines where a canary may simply be blocked: your canary is
   tried first, the built-ins stay behind it, and a refused connection counts as an
   answer — the line is only called down when no canary answers at all.

### #48 "risk of the config getting filtered when used together with the scanner"
**EZ Scanner** detects `sni == config domain` and warns before the scan starts,
suggests a generic SNI, and keeps the "scan with SNI X, inject into config Y"
workflow as the default route so a personal domain is never the scan target.

### #82 "the download test fails every address"
**Cause (found by reading the code):** the desktop speed-test call passed
`Tries: 1` while the health check required ≥2 successes — 100 % failure by
construction.
**EZ Scanner** decouples the two phases: throughput ranking runs only on already
healthy addresses (`topN`, default 20), uses the speed URL's own hostname as SNI
(a Cloudflare edge only serves `speed.cloudflare.com` when the SNI matches it —
verified against real edges), measures Mbps from the first byte, and never lets a
missing speed number alone reject an address (`test/scoring.test.ts → speed only
re-weights addresses that were actually measured`).

### #107 "Code audit" (15 findings, e.g. the old Pillow API in `gen_icons.py`)
**n/a / addressed by design.** There is no Python tooling and no version-pinned
image API here; the only generated binary artifact is the XLSX, whose CRC32/ZIP
writer is unit-tested (`test/export.test.ts`).

---

## Quality-of-life

| Issue | What EZ Scanner does |
|---|---|
| #93/#73 "no documentation / manual" | `README.md`, `docs/USAGE.md`, `docs/ISSUES.md`, `--help` for every command, and a quick-help panel inside the GUI |
| #70 "BPB note" | The config builder turns discovered addresses into ready BPB/v2ray links; scanning a BPB fronting domain works through the "config" source |
| #86/#86-like "which IP is best?" | Score (0–100) mixing latency, loss, DPI survival, HTTP validity and throughput + sortable columns |
| "is it my line or the tool?" | `ezscan doctor` (DNS/TCP/TLS/HTTP/speed checks with hints; the DNS check flags block-page answers and compares the system resolver against DNS-over-HTTPS) and `ezscan selftest` (probes real edges and prints a verdict) |
| "which preset does my line need?" | `ezscan doctor` measures the line's signature — sessions turned away under a held burst, connections reset with nothing else open, and a large transfer that stops moving — and names the preset for it (see #25, #56, #58, #96). Nothing detected means no operator preset is needed |

---

## Pipeline lessons — for the next workflow change

Each of these was learned by dispatching the change for real, not by reading it. The rule
stands until a workflow file is touched again; re-read it before editing one.

### 1. A called workflow checks out nothing — pass the ref through

**What happened.** The release gate calls `flake.yml` with `workflow_call` to hunt the tag's
commit before publishing. A called workflow runs in a **fresh workspace**, and a bare
`actions/checkout` there takes `github.sha` — the commit the *caller ran on*, not the one the
caller checked out. On a tag push the two are the same commit, so the bug is invisible; on a
dispatched re-publish (which runs on `main` while shipping an older tag) the hunt would have
hammered `main` forever while claiming to guard the tag.

**The rule.** Any `workflow_call` job that must act on a specific ref takes that ref as an
input and checks it out explicitly (`flake.yml`'s `ref` input, default `github.sha`). A gate
that cannot name the commit it gates is decoration. Note the corollary: `uses:` resolves the
called workflow **file** from the caller's commit, so the hunt of an old tag runs that
*caller's* copy of the hunt script — old tags legitimately lack newer script features (see 3).

### 2. A re-publish must not rewrite hand-corrected release notes

**What happened.** The release workflow extracts notes from the tag's `CHANGELOG.md` —
deterministic per tag, which is right. But a body corrected *after* publishing (1.7.6's
"no file under `src/` changes" claim was false and fixed on the release while the frozen tag
kept the original wording) differed from that extraction, so every re-publish silently
regressed the public notes back to the wrong claim. Found only because the re-publish path
was exercised end to end.

**The rule.** On a dispatched re-publish, compare the extraction against the live body
first: a difference **is** the hand-correction, so it is kept verbatim;
`reset-notes=true` is the explicit way to say the changelog now supersedes it. Fresh
publishes (no existing release) always publish the extraction. Assets are rebuilt from the
tag and are therefore bit-identical across re-publishes — only the body can carry
post-publish truth.

### 3. Evidence steps must tolerate trees that predate the evidence

**What happened.** The hunt's artifact upload was `if-no-files-found: error`. But the gate
hunts the *tagged* tree (rule 1), and a tag from before the evidence feature existed produces
no `flake-hunt-results.json` by design — so a 6-for-6 green hunt of v1.7.6 was failed by its
bookkeeping. The gate should never be stricter than the thing it guards.

**The rule.** `if-no-files-found: warn` for artifacts produced by optional instrumentation,
and the writer says loudly when a configured sink fails (`writeResultsFile` logs unwritable
paths) — silent skips and loud failures must be distinguishable three steps later. Generally:
before adding a hard failure to a workflow, ask which *old refs* it will run against, because
on dispatch it runs against all of them.

### 4. A test may only read a live field as a claim about the whole run if the field cannot drift

**What happened.** The reset-churn assertion read `stats.backoffFactor` after the sweep — that
field is the *last completed address's* value and decays (÷1.3 whenever the failure ratio drops
under 0.25), so a sweep that slowed hard and finished on a run of successes read 4 where it
peaked at 8. It flaked in CI on a docs-only commit. The same class was hiding in the worker
budgets: the line's `peakConcurrent` leads the caller by a reap cycle, so a strictly serial
caller reads 2 there.

**The audit and its verdicts.** The whole suite was then swept for this class — every test
read of a stateful stats field, judged against the field's meaning in `src/`. The verdicts,
kept here so the next stat inherits the checklist instead of rediscovering it:

| Field | Nature | Verdict |
|---|---|---|
| `done / ok / failed / healthy` | monotonic counters | safe — last read equals the whole run |
| `backoffFactor` | live, last address, decays | **was the one drifter** — claims now read `peakBackoffFactor`; field doc says what it is |
| `peakBackoffFactor` | accumulated high-water mark | safe — the whole-run value, recorded where the delay is applied |
| snapshot round-trip | peak inherits, live must not | `restore()` spreads the snapshot over fresh stats — it pinned `backoffFactor: 1` explicitly |
| `rate / etaMs / elapsedMs` | windowed | safe in tests — fixtures only, never read from a real run |
| `phase` | state machine | safe — asserted at terminal states or as a fixed constant |
| `offline` / `getNetwork()` | edge-flappy | safe — read right after `check()`, via `waitFor` on the edge itself, or collected as events over time |
| `line.stats.peakConcurrent` (burst) | real table peak | safe as a *whole-run* read — its flake was the precondition racing dial speed (fixed by `preFill`) |
| `line.stats` counters (`refused / resets / outages / stalls`) | monotonic | safe — read after the sweep |
| `line.client.peak / opened / live` | accumulated / terminal | safe — counted from `connect` to `destroy`, no reap lag |
| `backoff.factor` (unit) | live | safe — deterministic record sequences drive it |
| `watchdog.state.checks / failures` | counters + edge | safe — explicit `check()`/`reset()` control |

**The rule.** Before an assertion reads a stats field, classify it: a *monotonic counter* or
*accumulated high-water mark* may carry a whole-run claim; a *live/last-sample* value may only
carry a claim about the state at a synchronised point (terminal, quiesced, or on the event's
own edge). A whole-run claim about a decaying quantity needs a new accumulated field recorded
where the quantity is applied — not an out-of-band sampler, whose timing becomes the thing
under load. And write the field doc at the definition site saying which kind it is: that doc
is what stopped the next reader from repeating this.
