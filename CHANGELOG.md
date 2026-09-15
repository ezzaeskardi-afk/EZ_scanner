# Changelog

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
