/**
 * Config safety net.
 *
 * A scanner that silently accepts `workers=100000` is a scanner that kills the
 * user's router. Everything is clamped, and combinations that are known to
 * produce "everything is red" get an explicit warning (issues #48, #102, #131).
 */
import { DEFAULT_CONFIG, type ProbeMode, type ScanConfig, type SourceSpec } from './types.ts';

interface SanitizeResult {
  config: ScanConfig;
  warnings: string[];
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Like `int`, but out-of-range values fall back instead of being clamped to an edge value. */
function intStrict(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return rounded >= min && rounded <= max ? rounded : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'off') return false;
  return fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * A value the probe engine can actually ask for.
 *
 * The old check was `/^https?:\/\//`, which accepts `https://` — a value the URL parser then
 * refuses, so the throughput phase was pointed at an endpoint that cannot exist and the URL's own
 * hostname (which is also the SNI `speedSni` derives) was nonsense. Anything that cannot be parsed
 * as a URL, or is not http(s), is refused here, where the user's value enters and where a warning
 * can name it.
 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeSni(value: string): string {
  let s = value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^\.+|\.+$/g, '');
  return s.toLowerCase();
}

export function sanitizeConfig(input: Partial<ScanConfig>, base: ScanConfig = DEFAULT_CONFIG): SanitizeResult {
  const patch = input as Record<string, unknown>;
  const warnings: string[] = [];
  const merged: ScanConfig = { ...base };

  if (patch.mode !== undefined) {
    const mode = str(patch.mode, base.mode) as ProbeMode;
    merged.mode = mode === 'tcp' || mode === 'tls' || mode === 'http' ? mode : base.mode;
    if (patch.mode !== undefined && merged.mode !== patch.mode) warnings.push(`unknown probe mode "${String(patch.mode)}" — kept ${base.mode}`);
  }
  if (patch.port !== undefined) {
    const requested = Number(patch.port);
    merged.port = intStrict(patch.port, base.port, 1, 65535);
    if (merged.port !== requested) warnings.push(`invalid port "${String(patch.port)}" — kept ${merged.port}`);
  }
  if (patch.sni !== undefined) merged.sni = normalizeSni(str(patch.sni, base.sni));
  if (patch.sniPool !== undefined) {
    const pool = Array.isArray(patch.sniPool) ? patch.sniPool : [];
    merged.sniPool = [...new Set(pool.map((s) => normalizeSni(String(s))).filter(Boolean))].slice(0, 20);
  }
  if (patch.tries !== undefined) merged.tries = int(patch.tries, base.tries, 1, 10);
  if (patch.minSuccesses !== undefined) merged.minSuccesses = int(patch.minSuccesses, base.minSuccesses, 1, merged.tries);
  if (merged.minSuccesses > merged.tries) merged.minSuccesses = merged.tries;
  if (patch.timeoutMs !== undefined) merged.timeoutMs = int(patch.timeoutMs, base.timeoutMs, 500, 30_000);
  if (patch.workers !== undefined) merged.workers = int(patch.workers, base.workers, 1, 1000);
  if (patch.maxLatencyMs !== undefined) merged.maxLatencyMs = int(patch.maxLatencyMs, base.maxLatencyMs, 50, 20_000);
  if (patch.maxLossPct !== undefined) merged.maxLossPct = int(patch.maxLossPct, base.maxLossPct, 0, 100);
  if (patch.requireHttp !== undefined) merged.requireHttp = bool(patch.requireHttp, base.requireHttp);
  if (patch.httpPath !== undefined) {
    const p = str(patch.httpPath, base.httpPath) || '/';
    merged.httpPath = p.startsWith('/') ? p : `/${p}`;
  }
  if (patch.requireWs !== undefined) merged.requireWs = bool(patch.requireWs, base.requireWs);
  if (patch.wsPath !== undefined) {
    const p = str(patch.wsPath, base.wsPath) || '/';
    merged.wsPath = p.startsWith('/') ? p : `/${p}`;
  }
  if (patch.stabilityMs !== undefined) merged.stabilityMs = int(patch.stabilityMs, base.stabilityMs, 0, 30_000);
  if (patch.earlyExit !== undefined) merged.earlyExit = bool(patch.earlyExit, base.earlyExit);
  if (patch.family !== undefined) {
    const requested = Number(patch.family);
    if (requested === 0 || requested === 4 || requested === 6) merged.family = requested as 4 | 6 | 0;
    else warnings.push(`invalid address family "${String(patch.family)}" — kept family ${base.family}`);
  }
  if (patch.measureSpeed !== undefined) merged.measureSpeed = bool(patch.measureSpeed, base.measureSpeed);
  if (patch.measureUpload !== undefined) merged.measureUpload = bool(patch.measureUpload, base.measureUpload);
  if (patch.speedUrl !== undefined) {
    const url = str(patch.speedUrl, base.speedUrl);
    merged.speedUrl = isHttpUrl(url) ? url : base.speedUrl;
    if (merged.speedUrl !== url) warnings.push('speed URL must be a full http(s) URL — kept the previous value');
  }
  if (patch.speedSni !== undefined) merged.speedSni = normalizeSni(str(patch.speedSni, base.speedSni));
  if (patch.speedBytes !== undefined) merged.speedBytes = int(patch.speedBytes, base.speedBytes, 100_000, 2_000_000_000);
  if (patch.speedTimeoutMs !== undefined) merged.speedTimeoutMs = int(patch.speedTimeoutMs, base.speedTimeoutMs, 1000, 120_000);
  if (patch.uploadUrl !== undefined) {
    const url = str(patch.uploadUrl, base.uploadUrl);
    merged.uploadUrl = isHttpUrl(url) ? url : base.uploadUrl;
    // The upload URL checks its value the same way the speed URL does — and says so. It used to
    // drop an invalid value in silence (the warning was added for one of the two and not the
    // other), so `--upload` against a typo'd URL quietly measured the default endpoint instead.
    if (merged.uploadUrl !== url) warnings.push('upload URL must be a full http(s) URL — kept the previous value');
  }
  if (patch.uploadBytes !== undefined) merged.uploadBytes = int(patch.uploadBytes, base.uploadBytes, 65_536, 100_000_000);
  if (patch.topN !== undefined) merged.topN = int(patch.topN, base.topN, 0, 2000);
  if (patch.rateLimitPerSec !== undefined) merged.rateLimitPerSec = int(patch.rateLimitPerSec, base.rateLimitPerSec, 0, 5000);
  if (patch.minDelayMs !== undefined) merged.minDelayMs = int(patch.minDelayMs, base.minDelayMs, 0, 10_000);
  if (patch.adaptiveBackoff !== undefined) merged.adaptiveBackoff = bool(patch.adaptiveBackoff, base.adaptiveBackoff);
  // These two were the only `ScanConfig` fields with no branch here, so every value that reached
  // them from a preset or a flag was dropped on the floor: the three operator presets' retry gap
  // and recovery pass never applied, `--retry-gap` did nothing, and `--no-recovery` turned off
  // something that was already off (the default). `test/config-fields.test.ts` now walks the
  // config and fails if a field is added here-less again.
  if (patch.betweenTriesMs !== undefined) {
    merged.betweenTriesMs = int(patch.betweenTriesMs, base.betweenTriesMs, 0, 10_000);
  }
  if (patch.recoveryPass !== undefined) merged.recoveryPass = bool(patch.recoveryPass, base.recoveryPass);
  if (patch.autoPauseOnNetworkLoss !== undefined) {
    merged.autoPauseOnNetworkLoss = bool(patch.autoPauseOnNetworkLoss, base.autoPauseOnNetworkLoss);
  }
  // An explicitly empty value clears the custom canary and goes back to the built-in ones;
  // `|| base.canaryHost` made a canary impossible to remove once it had been set.
  if (patch.canaryHost !== undefined) merged.canaryHost = str(patch.canaryHost, base.canaryHost);
  if (patch.canaryPort !== undefined) merged.canaryPort = int(patch.canaryPort, base.canaryPort, 1, 65535);
  if (patch.minScore !== undefined) merged.minScore = int(patch.minScore, base.minScore, 0, 100);

  if (merged.requireWs) {
    warnings.push(
      'require-WS is ON: on DPI-heavy lines the websocket upgrade false-negatives and everything looks red. ' +
        'Leave it off unless your client really uses ws (issue #102).',
    );
  }
  if (merged.stabilityMs > 0) {
    warnings.push(
      `idle hold ${merged.stabilityMs}ms is ON: connections that a DPI box kills while idle are rejected. ` +
        'That is the strictest gate — enable it only after you already have results.',
    );
  }
  if (merged.workers > 150 && merged.rateLimitPerSec === 0) {
    warnings.push(
      `${merged.workers} workers with no rate limit is a burst profile that some operators answer by dropping the whole line (issues #25/#62). ` +
        'Consider the gentle preset.',
    );
  }
  if (merged.mode === 'tcp' && (merged.requireWs || merged.requireHttp)) {
    warnings.push('mode "tcp" ignores the HTTP/WS gates: switch to tls/http if you want them checked');
  }
  if (!merged.sni && merged.mode !== 'tcp') {
    warnings.push('no SNI set: most edges need one to serve your host (paste your config link to auto-fill it)');
  }
  if (merged.measureSpeed && merged.speedBytes > 50_000_000) {
    warnings.push('large speed size: each speed test moves that many bytes per address');
  }
  return { config: merged, warnings };
}

export function sanitizeSource(patch: Partial<SourceSpec>, base: SourceSpec = { kind: 'cloudflare' }): SourceSpec {
  const raw = patch as Record<string, unknown>;
  const kind = str(raw.kind, base.kind);
  const allowed: SourceSpec['kind'][] = ['cloudflare', 'paste', 'file', 'domains', 'config'];
  const out: SourceSpec = {
    kind: allowed.includes(kind as SourceSpec['kind']) ? (kind as SourceSpec['kind']) : base.kind,
    text: typeof raw.text === 'string' ? raw.text : base.text,
    path: typeof raw.path === 'string' ? raw.path : base.path,
    config: typeof raw.config === 'string' ? raw.config : base.config,
    extended: raw.extended !== undefined ? bool(raw.extended, Boolean(base.extended)) : base.extended,
    limit: raw.limit !== undefined ? int(raw.limit, base.limit ?? 5000, 0, 2_000_000) : base.limit,
    seed: raw.seed !== undefined ? int(raw.seed, base.seed ?? 1337, 0, 2 ** 31 - 1) : base.seed,
  };
  return out;
}
