# Changelog

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
