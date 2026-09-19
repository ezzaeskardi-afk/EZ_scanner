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
