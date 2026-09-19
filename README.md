# EZ Scanner

**Find clean Cloudflare IPs for SNI-fronted tunnels — with a real GUI and a complete CLI.**
Clean-IP discovery for Cloudflare fronted tunnels (vless / vmess / trojan / BPB style), with a local GUI, a scriptable CLI, resumable scans and honest diagnostics.

[![tests](https://img.shields.io/badge/tests-119%20passing-brightgreen)](#tests)
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
| A long scan restarts from zero | No session snapshot | Snapshot every 15 s + **resume from the cursor** |
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
   time left), an operational status line (phase · elapsed · in flight · back-off) and the
   **failure breakdown** as chips.
3. **Results** — a live table with sorting (and `aria-sort`), filtering, bulk selection,
   one-click copy, re-probe / re-test speed and "scan only these". The *status* column says
   **why** a row is red in plain words (`loss 67% > 50%`) while the engine's raw string
   stays in the tooltip.
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

---

## CLI

```bash
ezscan gui                                     # the GUI
ezscan scan --preset gentle --count 2000 --sni my.sni.example --csv out.csv
ezscan scan --source config --config "vless://…" --speed --xlsx found.xlsx  # the config's own address
ezscan scan --count 3000 --sni my.sni.example --speed --xlsx found.xlsx      # the ranges, that SNI
ezscan scan --source paste --targets my-ips.txt --csv out.csv   # probe phase only
ezscan resume a1b2c3d4                         # continue a session
ezscan sessions                                # list sessions
ezscan export a1b2c3d4 --format links --link-template "vless://…" --out links.txt
ezscan doctor                                  # DNS (tampering included) /TCP/TLS/HTTP/throughput
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
| `csv` | 20 columns with a BOM for Excel, including the rejection reason |
| `xlsx` | a real Excel file with no external library (stored ZIP + CRC32) |
| `json` / `ndjson` | for scripts and automation |
| `links` | ready-to-import links: `vless://…@<ip>:443?…#EZ-<ip>-<latency>` |

---

## Sessions and resuming

Every scan is snapshotted automatically under `~/.ez-scanner/sessions/` (every 15 s, and on
finish/pause/stop/abort). A snapshot holds the config, the full address list, the cursor,
the results and failure samples. `--resume` or the GUI's "Load & resume" continues from the
exact address, even after a reboot.

---

## FAQ

**I get no IPs at all.** Run `ezscan doctor`, then `ezscan selftest`; the output says whether
the line or the gates are at fault. If selftest is green, set `minScore` to `0` and keep
WS/idle off. If doctor flags the resolver, the line is rewriting DNS answers: scan by IP
(the Cloudflare or Paste source) instead of by domain.

**Why does the measured speed differ from my tunnel?** The probe measures the direct path to
the edge (no proxy) and is meant for **ranking** IPs. Judge the final number inside your
client.

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
scripts/     maintenance tooling: OpenUI style pruning (no build step, gated in CI)
test/        119 tests: probe against a local TLS server, stop/resume, snapshots, API and
             security, exports, the OpenUI report, the HTML/CSS/JS contract, the CLI run as
             a user runs it, the dead-code / version / pruned-stylesheet gates
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
npm test                  # 132 tests: probe engine, gating, pause/resume, snapshots,
                          # exports, HTTP API, OpenUI report, GUI contract, CLI, dead code,
                          # and integration runs against a fake hostile access network
npm run check:openui-css  # the vendored OpenUI stylesheet is still minimal, complete and correctly pinned
npm run check:deadcode    # CI gate: dead exports, unused CSS tokens, unused runtime strings, non-English text
```

The tests stand up a **local fake edge** (TLS + WebSocket + a slow/hostile server) and
exercise the engine without needing the real internet; `npm run selftest` runs a real scan
against Cloudflare addresses. `test/hostile-line.test.ts` goes further: its upstream
(`test/helpers/hostile-line.ts`) has a **hard session limit** that resets the sessions past
it and drops the whole line when it is filled, adds delay/jitter to every response, and can
**black-hole an MTU-sized transfer** part-way through. That is what lets the suite assert
the claims instead of describing them: a worker burst trips the table and loses addresses,
the same addresses under a worker budget that fits are all found, a timeout tighter than the
line turns it all red while a viable one turns it all green, a resetting line raises the
inter-probe delay instead of being hammered, and a stalled transfer is measured as slow
without hanging the run or poisoning the verdict on a healthy address — and a line that
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

## Releases

Pushing a `v*` tag publishes a release on its own: the workflow runs the typecheck, the two
gates and the test suite, packages the tracked files as `ez-scanner-<version>.zip`, writes
`SHA256SUMS.txt`, takes the notes from `CHANGELOG.md` and attaches all three. The same notes
are one command locally (`npm run notes -- 1.3.0`), so what a release says is what the
changelog says. The zip needs no build step, no dependencies and no toolchain — Node 22.18+
is the only requirement.

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
