# EZ Scanner

**Find clean Cloudflare IPs for SNI-fronted tunnels — with a real GUI and a complete CLI.**
Clean-IP discovery for Cloudflare fronted tunnels (vless / vmess / trojan / BPB style), with a local GUI, a scriptable CLI, resumable scans and honest diagnostics.

[![tests](https://img.shields.io/badge/tests-229%20passing-brightgreen)](#tests)
[![node](https://img.shields.io/badge/node-%E2%89%A522.18-blue)](#install)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

```
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │  sources     │ → │  probe pool  │ → │  gates       │ → │  output      │
 │  CF ranges   │   │  workers     │   │  latency     │   │  GUI table   │
 │  paste/CIDR  │   │  rate limit  │   │  loss / WS   │   │  CSV/XLSX    │
 │  domains     │   │  watchdog    │   │  idle hold   │   │  ready links │
 │  config link │   │  pause/resume│   │  score       │   │  sessions    │
 └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

---

## Why this project exists

Most "no green IPs" reports against similar scanners are not an engine failure — they are
**strict gates that are on by default and never spelled out**. EZ Scanner was written from
that bug list:

| Common complaint | Actual cause | What EZ Scanner does |
|---|---|---|
| Everything is red, even healthy IPs | WebSocket + idle-hold checks defaulted to **on** | Both are **off**; each gate is a visible switch |
| The speed test always fails | One try could never satisfy a "≥2 successes" rule | Gates are explicit and countable (`minSuccesses`) |
| Finding a working SNI | No SNI field in the GUI | SNI field + automatic parsing of your config link |
| Getting the results out | Copy/export was broken | CSV, XLSX, JSON, NDJSON, clipboard and **ready configs** |
| The line dies mid-scan | Huge unscoped scan with no rate limit | Rate limit, per-worker delay, adaptive back-off, **auto-pause when the line drops** |
| A long scan restarts from zero | No session snapshot | Snapshot every 15 s + **resume from the cursor** (with the settings you can see — a resume is the same scan continued) |
| "The download test fails every address" | A failed transfer was reported as throughput | The speed column carries a **verdict** (`measured` / `short` / `cut` / `stalled` / `refused`), and only a `measured` number may rank an address — see [Throughput](#throughput-what-the-speed-column-means) |
| Pasting my own IP/domain list | Text files only | Paste list, CIDR, ranges, `ip:port`, domains and config links |

Full mapping against the reference project's issues: [`docs/ISSUES.md`](docs/ISSUES.md).

---

## Install

Requires **Node.js 22.18 or newer** (24 LTS recommended). No compiler, no WebView, no
system dependency.

```bash
git clone https://github.com/ezzaeskardi-afk/EZ_scanner.git
cd EZ_scanner
npm install            # only typescript + @types/node
npm start              # opens the GUI on http://127.0.0.1:8788
```

Or install the `ezscan` command globally:

```bash
npm install -g .
ezscan gui
```

Windows: double-click `start-gui.cmd`. Linux/macOS: `./start-gui.sh`.

---

## The GUI

`npm start` brings up a local server on `127.0.0.1` and opens your browser. Security
model: loopback only, every mutating request needs the per-run token, cross-origin requests
are rejected (all covered by tests).

The layout is an **operations console**, not a form followed by a table: a setup rail next
to a live console, with a four-tab dock underneath.

1. **Scan setup** (left rail) — presets, address source and every parameter, grouped into
   collapsible sections (probe, throughput, safety / anti-detection).
2. **Live console** — progress bar, six **KPIs** (checked, answered, no answer, clean, rate,
   time left), an operational status line (phase · elapsed · in flight · back-off, read next to
   the sweep's peak so the line's push and its recovery are both visible) and the
   **failure breakdown** as chips.
3. **Results** — a live table with sorting (and `aria-sort`), filtering, bulk selection,
   one-click copy, re-probe / re-test speed and "scan only these". The *status* column says
   **why** a row is red in plain words (`loss 67% > 50%`) while the engine's raw string
   stays in the tooltip. The throughput columns show the rate, or the **verdict that replaced
   it** (`!short`, `!cut`, `!stalled`, `!refused`) with the full word as the cell's tooltip;
   *Re-probe* re-measures the probe phase only, so a row's throughput survives it.
4. **Bottom dock** — four tabs: **Live log**, **OpenUI dashboard**, **Export & config**
   (CSV/XLSX/JSON/TXT/IPs-only plus ready configs built from your link) and **Tools**
   (saved sessions, line diagnostics, quick help).

Interface notes:

- **Live / stale / disconnected indicator** is fed by the real SSE heartbeat: it never says
  "live" while nothing is arriving, and the tooltip says when the last message landed.
  "Pause live updates" stops repainting only — nothing is dropped, and the pill reports how
  much is buffered.
- **English-only, no webfonts.** The UI shipped a FA/EN layer and a self-hosted Vazirmatn
  font up to 1.2.0; 1.3.0 removed both, so the GUI renders with the platform font stack and
  ships zero font bytes. `test/gui.test.ts` and `test/deadcode.test.ts` fail the build if
  non-English text or a webfont creeps back in.
- Light/dark theme is a toggle and is remembered; contrast is checked in both themes.
- Accessibility: icons are one SVG sprite (no emoji), every icon-only control has a label
  and a tooltip, tabs respond to arrow keys, focus is always visible and
  `prefers-reduced-motion` is honoured.
- Static files are served gzipped (the OpenUI bundle goes from 3.6 MB to ~1 MB) and
  versioned files are cached with `?v=` for a week. The vendored OpenUI stylesheet is
  **pruned** before release to the components the report actually renders (310 KB → 102 KB
  raw, 33.3 KB → 9.1 KB gzip, 1837 → 448 rules) and its `?v=` comes from the file's content
  hash.

Presets:

| Preset | Mode | Tries / successes | Workers | WS | Idle | Safety |
|---|---|---|---|---|---|---|
| `fast` | tcp | 1/1 | 200 | off | off | none |
| `standard` | tls | 3/2 | 50 | off | off | none |
| `strict` | http | 4/3 | 40 | on | 1.5 s | none |
| `gentle` (Iran-friendly) | tls | 2/1 | 20 | off | off | 12 conns/s + 40 ms delay |
| `irancell` (mobile CGNAT) | tls | 3/1 | 12 | off | off | 12 conns/s + 40 ms delay, retries 250 ms apart, recovery pass |
| `mci` (Hamrah-e Aval) | tls | 3/1 | 12 | off | off | 10 conns/s + 60 ms delay, retries 350 ms apart, recovery pass |
| `mobin` (MobinNet fiber) | tls | 2/1 | 12 | off | off | 12 conns/s + 40 ms delay, retries 150 ms apart, recovery pass |

The last three are **per-operator** profiles: each one is measured against a model of that
network (its session table, its cap on new sessions per second, its DPI resets) in
`test/operator-profiles.test.ts`, and `--preset` takes the aliases `mtn`, `hamrah` and
`mobinnet` too. [`docs/USAGE.md`](docs/USAGE.md) has the table of what each one protects
against.

They probe with a **TLS handshake** rather than a bare connect, because on these networks a
blocked path still completes the TCP handshake: measured against the harness line, `tcp` called
40 of 40 addresses healthy while the line was refusing every session, where `tls` called the 11
that were actually reachable. They also space their retries (`--retry-gap`) and **retry the
addresses the line itself turned away** once the window has passed (`--no-recovery` to disable);
the same line, blocked for three seconds mid-sweep, went from 13/40 to 37/40 addresses found.

After `ezscan doctor` has measured your line, the next `ezscan scan` **applies the preset it named
by itself** (for 12 hours — an operator's throttling is a property of the hour, not of the
address) and says which one it used and why. An explicit `--preset` wins, and `--no-adapt` scans
with exactly the flags you gave.

---

## Throughput: what the speed column means

The speed phase exists to **order addresses by a number**, so the question "did this transfer
actually happen?" matters more than the number it produced. Every measurement carries a verdict,
and only one of them is a number the ranking may use:

| Verdict | What it means | Does it rank? |
|---|---|---|
| `measured` | The payload arrived (or *we* ended the window while it was still arriving). The rate describes the path. | ✅ yes |
| `partial` | The endpoint ended the stream before the payload it had promised — a byte cap or a proxy on the endpoint. Shown as `!short`. | ❌ it is evidence *against* the path |
| `cut` | The socket failed mid-transfer: a DPI/NAT box or an MTU hole reacting to volume. `!cut`. | ❌ evidence against the path |
| `stalled` | The deadline passed with the stream silent for 1.5 s — the PPPoE/PMTUD hole. `!stalled`. | ❌ evidence against the path |
| `rejected` | The endpoint answered, but not with a transfer (an error page, a TLS alert, an SNI the edge does not serve). `!refused`. | ❌ neither ranks nor penalises |
| `untested` | The speed phase never reached this address, or the scan was stopped. `-`. | ❌ neither |

Why it is not just a zero: a short transfer is measured over its **first congestion window**,
which is where a transfer is fastest — so a gateway that caps 64 KB of an 8 MB request used to
produce the *best-looking* number in the scan. And "we could not find out" must not beat "we found
out, and it is slow", so a distrust (`partial`/`cut`/`stalled`) takes the speed weight with a part
of zero, and the batch baseline is the fastest *trusted* download. The verdicts travel with the
results: `!short`/`!cut`/`!stalled`/`!refused` in the CLI table, `down_trust`/`up_trust` in the CSV
and XLSX, the word in the GUI tooltip, and a named verdict in the OpenUI report — so the reader and
the ranking can never disagree. `ezscan doctor` reads the same value and gives one hint per verdict
(a stall → the `mobin` preset, a cut → fewer bytes or `--no-speed`, a short stream → `--speed-bytes`
or a different `--speed-url`, a refusal → a speed URL your line can reach).

---

## CLI

```bash
ezscan gui                                     # the GUI
ezscan scan --preset gentle --count 2000 --sni my.sni.example --csv out.csv
ezscan scan --preset mci --count 2000 --sni my.sni.example --csv out.csv   # per-operator preset
ezscan scan --source config --config "vless://…" --speed --xlsx found.xlsx  # the config's own address
ezscan scan --count 3000 --sni my.sni.example --speed --xlsx found.xlsx      # the ranges, that SNI
ezscan scan --source paste --targets my-ips.txt --csv out.csv   # probe phase only
ezscan resume a1b2c3d4                         # continue a session
ezscan sessions                                # list sessions
ezscan export a1b2c3d4 --format links --link-template "vless://…" --out links.txt
ezscan doctor                                  # DNS (tampering included) /TCP/TLS/HTTP/throughput
                                              # + the line's signature and the preset it needs
                                              # (the next scan applies that preset by itself;
                                              #  --no-adapt keeps your own flags)
ezscan selftest                                # "is it my line or my settings?"
ezscan config "vless://…"                      # SNI/port/transport of a config
ezscan scan --help                             # every option
```

Terminal output stays usable without colour vision: states are tagged `[OK]`/`[--]`/`[!!]`,
not just coloured (`--no-color`, `NO_COLOR`).

---

## Gates: what is actually checked?

Each attempt walks exactly as far as you allow:

```
TCP connect → TLS handshake → HTTP/1.1 response → WebSocket upgrade → idle hold
   (all)         (default)      (default on)        (default off)      (default off)
```

| Gate | Default | Meaning | When to turn it on |
|---|---|---|---|
| `requireHttp` | ✅ | Get a valid HTTP response from the edge (proves the path really works) | Always, unless you want `tcp` mode |
| `requireWs` | ❌ | WebSocket upgrade answered with 101 | Only if your config really uses `ws` |
| `stabilityMs` | `0` (off) | Hold the connection idle and reject it if DPI kills it | After you have your first results |
| `minSuccesses` | `2` of `3` | How many attempts must succeed | `1` on unstable lines |
| `earlyExit` | ✅ | Stop as soon as the quota is met | Always (a multiple of the scan speed) |
| `maxLossPct`, `maxLatencyMs`, `minScore` | 50 / 1800 / 45 | Quality thresholds | Per your needs |

If you get nothing: use the **gentle** preset, set `minScore` to `0`, and run
`ezscan doctor`.

---

## Line safety and anti-detection

Operators answer a heavy scan with a full outage. Three independent layers:

- **Global rate limit** (`rateLimitPerSec`) and **per-worker delay** (`minDelayMs`).
- **Adaptive slow-down**: the failure ratio is tracked with an EWMA and the gap between
  probes grows automatically when resets/timeouts spike, relaxing again when the line calms.
- **Line watchdog**: canaries get a trial TCP connect every few seconds; when the line dies
  the scan **parks**, and it resumes automatically once the line comes back. It fails open:
  your canary is tried first and the built-ins (1.1.1.1:443, 8.8.8.8:53, 9.9.9.9:443) stay
  behind it, so a canary the operator blocks can never park a healthy scan; a refusal also
  counts as an answer, because a RST proves the path works. Only when *no* canary answers at
  all is the line called down. Set `canaryHost`/`canaryPort` (CLI: `--canary host:port`) to
  watch your own endpoint first, and run `--no-autopause` to disable parking entirely. The
  network state reports every endpoint that was offered a turn.

You also get a warning when the SNI equals your own domain (scanning with a personal domain
raises the odds of it being filtered) — the recommended route is to scan with a generic SNI
and swap the address into your own config, which is exactly what "Build configs" does.

---

## Outputs

| Format | Use |
|---|---|
| `txt` | `ip:port` per line (v6 addresses bracketed) |
| `hosts` | addresses only |
| `csv` | 23 columns with a BOM for Excel, including the rejection reason, the recovery flag and the throughput verdicts (`down_trust`, `up_trust`) |
| `xlsx` | a real Excel file with no external library (stored ZIP + CRC32) |
| `json` / `ndjson` | for scripts and automation |
| `links` | ready-to-import links: `vless://…@<ip>:443?…#EZ-<ip>-<latency>` |

`links` rewrites the address into the link you paste as the template (`--link-template`, or the
GUI's *Export & config* tab): `vless`/`trojan`/`hysteria2`/`tuic` keep their parameters, `vmess` is
re-encoded around the new `add`, and `ss://` is rewritten in both of its forms — including the
legacy one that is a single base64 blob. A template whose address cannot be rewritten (an
Xray/v2ray JSON document, for instance) is refused with an error instead of being copied once per
row.

---

## Sessions and resuming

Every scan is snapshotted automatically under `~/.ez-scanner/sessions/` (every 15 s, and on
finish/pause/stop/abort). A snapshot holds the config, the full address list, the cursor,
the results and failure samples. `--resume` or the GUI's "Load & resume" continues from the
exact address, even after a reboot.

A resume is the same scan **continued**, which decides what happens to the settings:

- **CLI**: the flags you pass are a *patch* on top of the config the session was saved with, so
  `ezscan resume <id> --speed --top 30` adds a phase to a session whose SNI, worker count and rate
  limit are the ones the run was actually started with. With no flags at all, the session's own
  settings are used. `--no-adapt` and `--preset` behave as they do on `scan`.
- **GUI / API**: the form you are looking at is what the resumed run uses — the session contributes
  its addresses, cursor and results. Editing a field and pressing resume no longer runs the
  session's old value. A resume request that carries no settings at all (a script calling
  `POST /api/scan/start` without a `config`) keeps the session's own, the same as a flagless
  `ezscan resume`.

---

## FAQ

**I get no IPs at all.** Run `ezscan doctor`, then `ezscan selftest`; the output says whether
the line or the gates are at fault. If selftest is green, set `minScore` to `0` and keep
WS/idle off. If doctor flags the resolver, the line is rewriting DNS answers: scan by IP
(the Cloudflare or Paste source) instead of by domain — and a resolver that answers nothing is
reported as a failure, not as "no answer". If doctor names a preset, that is the answer — and the
next `ezscan scan` picks it up on its own (`--preset <name>` says it explicitly, `--no-adapt`
ignores it). If it says the measurement could
not name one, that is a real answer too: not one probe completed even on an idle line, so the
problem is the path to your edge (SNI, tunnel host, or a network that blocks it), not the scan
parameters.

**Why does the measured speed differ from my tunnel?** The probe measures the direct path to
the edge (no proxy) and is meant for **ranking** IPs. Judge the final number inside your
client.

**The speed column says `!cut` / `!short` / `!refused` instead of a number.** That *is* the
answer, and it is deliberately different from a `0` (see [Throughput](#throughput-what-the-speed-column-means)):
`!short` and `!cut` are the path or the endpoint refusing a transfer it had agreed to send (lower
`--speed-bytes`, or scan with `--no-speed`), `!stalled` is the PPPoE/PMTUD signature the `mobin`
preset exists for, and `!refused` means the speed endpoint answered with something that is not a
transfer — usually a `--speed-url` this line cannot reach. `ezscan doctor` prints one hint per
verdict, and its throughput row is the same measurement the scan reads.

**Does it work on a phone?** The GUI is a web page: with Node installed on Linux/Termux run
`ezscan gui --no-open` and open the printed URL from a browser on the same network (the
server binds loopback by default; change the bind for network access).

---

## Architecture

```
src/
  core/      dependency-free engine: probe, scoring, ipsrc, ratelimit, scanner, export, zip/xlsx, openui
  server/    local HTTP + SSE for the GUI  +  doctor/selftest
  gui/       build-free UI (plain HTML/CSS/JS, English-only) + vendor/openui
  cli/       command line
scripts/     maintenance tooling: OpenUI style pruning, and the flake hunt (no build step)
test/        229 tests: probe against a local TLS server (including every throughput
             verdict), stop/resume, snapshots, API and security, exports, the OpenUI report,
             the HTML/CSS/JS contract, the CLI run as a user runs it, the line-signature
             measurement that names a preset and the scan that adopts it, the dead-code /
             config-field / version / stylesheet gates
```

Design philosophy: **no runtime dependencies** (only devDependencies for type checking),
TypeScript executed by Node's own type stripping, and the decision logic (`scoring.ts`) kept
as pure, tested functions. The only vendored "library" is the prebuilt OpenUI bundle under
`src/gui/vendor/openui`, which is what makes the dashboard work offline.

---

## OpenUI dashboard

The "OpenUI dashboard" tab uses [OpenUI](https://github.com/thesysdev/openui) — its UI
language and renderer — so the scan ends in a visual report instead of a bare table:

- `src/core/openui.ts` turns the scan state (KPIs, latency histogram, cleanest addresses,
  failure reasons, active gates) into an **OpenUI Lang** document:

```
root = Card([header, verdict, kpis, gates, chartHeader, chart, topHeader, topTable, failsTable])
verdict = Callout("success", "Scan produced clean addresses", "5 address(es) passed every gate. …")
kpis = SnippetCardBlock([kpi1, kpi2, kpi3, kpi4, kpi5], "grid", true)
chart = BarChart(chartLabels, [chartSeries], "grouped", "latency bucket", "Addresses")
```

- `src/gui/report.html` renders that document with the official `Renderer` and
  `openuiChatLibrary` (in an iframe, so OpenUI's own stylesheet cannot leak into the app).
- Buttons: **Refresh report**, **New tab**, **Copy Lang code**, **Download Lang code** —
  backed by `GET /api/report/openui?top=25&download=1`.
- The renderer lives in `src/gui/vendor/openui/`, so **no CDN is needed** — it works on
  lines where jsDelivr/unpkg are filtered.
- The Lang document is plain text: paste it into the OpenUI Playground or any other OpenUI
  app.

---

## Tests

```bash
npm run typecheck
npm test                  # 229 tests: probe engine, gating, pause/resume, snapshots,
                          # exports, HTTP API, OpenUI report, GUI contract, CLI, dead code,
                          # and integration runs against a fake hostile access network
npm run check:openui-css  # the vendored OpenUI stylesheet is still minimal, complete and correctly pinned
npm run check:deadcode    # CI gate: dead exports, unused CSS tokens, unused runtime strings, non-English text
npm run check:flake       # the integration suite again and again on a busy machine: --runs, --files, --load
```

The tests stand up a **local fake edge** (TLS + WebSocket + a slow/hostile server) and
exercise the engine without needing the real internet; `npm run selftest` runs a real scan
against Cloudflare addresses. `test/hostile-line.test.ts` goes further: its upstream
(`test/helpers/hostile-line.ts`) has a **hard session limit** that resets the sessions past
it and drops the whole line when it is filled, adds delay/jitter to every response, and can
**black-hole an MTU-sized transfer** part-way through. It counts the traffic two ways on
purpose: the line's own view — a session, from the accept until the line reaps it, which is what a
real conntrack table shows — and the caller's (`line.client`, the sockets the scan had open at
once; see `test/helpers/client-sockets.ts`). A line can only count a session until it notices it
is gone, one loopback round-trip behind the socket the scan already let go of, so a *worker
budget* — a statement about the caller — is asserted on the caller's count, and the line's
answers the session-table question. That is what lets the suite assert the claims instead of
describing them: a worker burst trips the table and loses addresses,
the same addresses under a worker budget that fits are all found, a timeout tighter than the
line turns it all red while a viable one turns it all green, a resetting line raises the
inter-probe delay instead of being hammered, and a stalled transfer is measured as slow
without hanging the run or poisoning the verdict on a healthy address (a cut, a byte cap, an
error page, an idle deadline and a stopped scan each reach their own verdict, and a transfer
whose bytes did arrive but whose payload never did is never allowed to rank) — and a line that
disappears *mid-sweep* parks the scan on the spot (state `offline`, the banner, the
`network:` log), consumes no address while it is down, and finishes the whole 60-address
list by itself once the line is back. `test/openui.test.ts` validates the OpenUI Lang grammar itself
(every line is `id = expr`, no undefined identifier, equal table column lengths, only
official library components), `test/gui.test.ts` holds the contract between
`index.html`/`app.js`/`styles.css` (every selected id exists, every icon resolves, every
marker string has a reader, both themes theme the same colours, no CDN, no webfont), and
`test/deadcode.test.ts` keeps "nothing consumes this yet" out of the tree: every exported
symbol must be imported from another file, every design token must be read with `var()`,
every runtime string must be rendered, and no non-English text may reappear anywhere.
A named CI step (`npm run check:deadcode`) runs first so a failure is obvious.

`test/openui-css.test.ts` does the same for the pruned OpenUI stylesheet: the file must stay
*minimal* (nothing left that the next prune run would drop), *complete* (all 85 styled
classes the report renders still have rules, and every component `src/core/openui.ts` can
emit maps to a class family) and *fresh* (`?v=` in `report.html` matches the file's content
hash, otherwise the server serves the unpruned copy for a week). The real class list is
recorded in `test/fixtures/openui-report-classes.txt`, separated from the documented
JS-only hooks.

If any of that rots, **CI goes red** — all checks run on the Windows/Linux × Node 22.18/24
matrix.

The suite is also run **on a schedule, against a loaded machine**, because a race passes one quiet
pass by construction: 1.7.4 shipped a test that failed on a runner while passing everywhere the
suite was run once in a row (the assertion and its fix are in the 1.7.5 notes).
`scripts/flake-hunt.ts` runs the integration files again and again with a busy process per CPU on
top, and then separates what it found instead of just going red — a test that fails in *some* runs
is a flake (the test, or the thing it measures, has a race in it), while one that fails in *every*
run is a break, and the two want different fixes. It runs on a schedule in the `Flake hunt`
workflow — nightly at the cheap floor (five passes, load 2), with a heavy net every Sunday night
(thirty passes, load 3) for the races too rare to meet in a single night — and it is one command
locally, with `--runs 6` for a longer hunt or `--files test/server.test.ts` to point it at one
suspect file. A failure is posted as an annotation against the commit, along
with the assertion's own message, so finding out which claim flaked does not depend on reading a
job log through the API, and every hunt uploads its per-pass results as the `flake-hunt-results`
workflow artifact — the evidence outlives the job log that also holds it. And a race must not reach a published artifact, so every release waits
on this hunt: the release workflow calls it on the tag's own commit — six passes, three busy
CPUs — and publishes nothing until it is green.

The hunt's record is measured, not promised. In the 1.7.6 A/B experiment, thirty loaded passes
over the hostile-line file on the shipped tag caught the burst precondition's race four times —
each failure posted with the assertion's own message — while thirty identical passes on
`main`, where the suspect assertion had been rewritten to read the run's own peak, stayed
green. The same experiment is honest about the limits: the backoff assertion whose CI flake
started all this never showed in thirty loaded passes of the tag it shipped in, because a race
that fails roughly one run in twenty needs a window no affordable hunt provides — it was fixed
by making the claim measurable, not by hoping to re-catch it. With both flakes fixed, the
thirty-pass confirmation came back clean twice, and the per-pass table and evidence artifact
each run leaves behind are the receipt of what was and was not met.

## Releases

Pushing a `v*` tag publishes a release on its own: the workflow first hunts the tagged commit for
flakes (six passes of the integration suite under CPU contention — a red hunt holds the release,
since the fix belongs on `main` and the next tag, not in a rewrite of a published one), then runs
the typecheck, the two gates and the test suite, packages the tracked files as
`ez-scanner-<version>.zip`, writes `SHA256SUMS.txt`, takes the notes from `CHANGELOG.md` and
attaches all three. The same notes
are one command locally (`npm run notes -- 1.7.7`), so what a release says is what the
changelog says. Re-publishing an existing tag keeps its published body when it differs from the
tag's own extraction — a difference is a hand-correction made after shipping, and the tag is
frozen (`reset-notes=true` says the changelog now supersedes it); the assets are rebuilt from
the tag and come back byte-identical. The zip needs no build step, no dependencies and no
toolchain — Node 22.18+ is the only requirement.

## Credits

- **OpenUI** (OpenUI Lang, its renderer and component library) — MIT,
  [thesysdev/openui](https://github.com/thesysdev/openui). The prebuilt
  `@openuidev/browser-bundle@0.1.4` files live in `src/gui/vendor/openui/` (details and the
  update procedure are in that folder). The bundle is copied untouched; the stylesheet is
  pruned to the components the report renders with `scripts/prune-openui-css.ts` (output and
  numbers in that folder's `PRUNE-REPORT.md`).
- The GUI palette and scale (OLED dark theme, status colours, spacing) were generated with
  the [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) design-system
  generator for a "real-time / operations dashboard", and the source tokens are recorded at
  the top of `src/gui/styles.css`. OpenUI's own styles apply inside the report iframe only.

## License

MIT — see [`LICENSE`](LICENSE). The bundled OpenUI parts are MIT as well (their license file
is kept next to them).
