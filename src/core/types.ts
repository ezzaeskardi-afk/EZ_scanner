/**
 * EZ Scanner — shared types.
 *
 * Everything below is intentionally plain data (no classes) so that a scan
 * session can be serialised to disk, resumed in another process, and rendered
 * by the GUI without any conversion step.
 */

export type ProbeMode = 'tcp' | 'tls' | 'http';

/** Where candidate addresses come from. */
type SourceKind = 'cloudflare' | 'paste' | 'file' | 'domains' | 'config';

export interface SourceSpec {
  kind: SourceKind;
  /** Raw text for `paste` / `domains` / `file` (file content is read by the CLI). */
  text?: string;
  /** Path for `file`. */
  path?: string;
  /** Config link (vless://, trojan://, ss://, vmess://) or raw Xray JSON. */
  config?: string;
  /**
   * Include the "extended" Cloudflare prefixes (ASN-derived /24s).
   * Off by default: measured hit-rate is much lower than the official ranges,
   * so it only dilutes the pool (see README "Why defaults are gentle").
   */
  extended?: boolean;
  /** Cap on how many addresses to generate from the source. 0 = unlimited. */
  limit?: number;
  /** Deterministic shuffle seed. */
  seed?: number;
}

export type ProbeErrorKind =
  | 'timeout'
  | 'refused'
  | 'reset'
  | 'tls'
  | 'http'
  | 'ws'
  | 'dns'
  | 'aborted'
  | 'unstable'
  | 'other';

export interface ProbeAttempt {
  ok: boolean;
  /** Total time for the decisive step (TCP connect / TLS handshake / first byte). */
  latencyMs: number;
  error?: ProbeErrorKind;
  errorMessage?: string;
  httpStatus?: number;
  wsOk?: boolean;
  /** True when the socket survived the idle-hold window (DPI detection). */
  stable?: boolean;
  idleMs?: number;
  /** Cloudflare edge code taken from the `cf-ray` response header, e.g. `FRA`. */
  colo?: string;
  serverHeader?: string;
}

export interface ScanConfig {
  /** Probe mode. `tcp` is the gentlest, `http` the most realistic. */
  mode: ProbeMode;
  port: number;
  /** TLS SNI / Host header. Empty = connect IP without SNI (works for IP-only CF edges). */
  sni: string;
  /** Optional SNI rotation pool — each try picks the next entry. */
  sniPool: string[];
  /** Attempts per address (default 3). */
  tries: number;
  /**
   * How many of `tries` must succeed before an address is "healthy".
   * Default 2. Never forced above `tries`.
   */
  minSuccesses: number;
  timeoutMs: number;
  workers: number;
  maxLatencyMs: number;
  maxLossPct: number;
  /** Require a well-formed HTTP/1.1 status line through the tunnel (default true). */
  requireHttp: boolean;
  httpPath: string;
  /** WebSocket upgrade check. OFF by default — it false-negatives on DPI hotspots. */
  requireWs: boolean;
  wsPath: string;
  /** Idle-hold window in ms to catch DPI RST-on-idle. 0 = disabled (default). */
  stabilityMs: number;
  /** Stop trying an address as soon as `minSuccesses` is reached (big speed win). */
  earlyExit: boolean;
  /** Address family filter. 0 = both. */
  family: 4 | 6 | 0;

  measureSpeed: boolean;
  speedUrl: string;
  /** SNI used for the speed endpoints. Empty = hostname of `speedUrl`. */
  speedSni: string;
  speedBytes: number;
  speedTimeoutMs: number;
  measureUpload: boolean;
  uploadUrl: string;
  uploadBytes: number;
  /** How many of the best healthy addresses get a speed test. 0 = all of them. */
  topN: number;

  /** Global cap of new connections per second. 0 = unlimited. */
  rateLimitPerSec: number;
  /** Per-worker pause between two addresses, smooths the burst profile. */
  minDelayMs: number;
  /** Slow down automatically when the failure ratio spikes. */
  adaptiveBackoff: boolean;
  /** Pause the whole scan when the internet itself goes away, resume when it's back. */
  autoPauseOnNetworkLoss: boolean;
  /** Canary used by the network watchdog. */
  canaryHost: string;
  canaryPort: number;

  /** Minimum score (0..100) an address needs to be listed as "green". */
  minScore: number;
}

export interface IpResult {
  ip: string;
  port: number;
  sni: string;
  /** Attempts actually made (may be < cfg.tries when earlyExit kicked in). */
  attempts: number;
  successes: number;
  lossPct: number;
  latencies: number[];
  medianLatency: number;
  bestLatency: number;
  jitter: number;
  httpStatus: number;
  wsOk: boolean | null;
  stable: boolean | null;
  stabilityMs: number;
  downMbps: number;
  upMbps: number;
  colo: string;
  /** Error kinds seen while probing (only for addresses that never succeeded). */
  errorKinds?: Record<string, number>;
  lastError?: string;
  score: number;
  healthy: boolean;
  /** Machine-readable rejection reasons, e.g. `loss 60% > 50%`. */
  reasons: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ScanStats {
  phase: 'idle' | 'expanding' | 'probe' | 'speed' | 'upload' | 'done' | 'stopped';
  total: number;
  done: number;
  ok: number;
  failed: number;
  healthy: number;
  startedAt: number;
  elapsedMs: number;
  /** addresses / second, measured over the last window */
  rate: number;
  etaMs: number;
  inflight: number;
  paused: boolean;
  backoffFactor: number;
  offline: boolean;
  message: string;
  /** Why addresses failed — the first thing to look at when "everything is red". */
  failuresByKind: Record<string, number>;
}

export interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error' | 'ok';
  text: string;
}

export interface SessionMeta {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  total: number;
  done: number;
  healthy: number;
  phase: ScanStats['phase'];
  file: string;
}

/** Snapshot persisted to disk (also the resume format). */
export interface SessionSnapshot {
  version: 1;
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  config: ScanConfig;
  source: SourceSpec;
  /** Full processing order (addresses as `ip` or `ip:port`), generated once. */
  targets: string[];
  cursor: number;
  /** Only addresses with at least one success are kept — everything else is noise. */
  results: IpResult[];
  /** Bounded sample of addresses that never succeeded, kept so "why is it red?" is answerable. */
  failures?: IpResult[];
  stats: ScanStats;
  logs: LogLine[];
}

export const DEFAULT_CONFIG: ScanConfig = {
  mode: 'tls',
  port: 443,
  sni: '',
  sniPool: [],
  tries: 3,
  minSuccesses: 2,
  timeoutMs: 4000,
  workers: 50,
  maxLatencyMs: 1800,
  maxLossPct: 50,
  requireHttp: true,
  httpPath: '/',
  requireWs: false,
  wsPath: '/',
  stabilityMs: 0,
  earlyExit: true,
  family: 4,
  measureSpeed: false,
  speedUrl: 'https://speed.cloudflare.com/__down?bytes=%BYTES%',
  speedSni: '',
  speedBytes: 8_000_000,
  speedTimeoutMs: 8000,
  measureUpload: false,
  uploadUrl: 'https://speed.cloudflare.com/__up',
  uploadBytes: 2_000_000,
  topN: 20,
  rateLimitPerSec: 0,
  minDelayMs: 0,
  adaptiveBackoff: true,
  autoPauseOnNetworkLoss: true,
  canaryHost: '1.1.1.1',
  canaryPort: 443,
  minScore: 45,
};

/** Presets surfaced in both the GUI and the CLI (`--preset`). */
export const PRESETS: Record<string, Partial<ScanConfig>> = {
  /** Gentle: lowest traffic profile, good for throttled/hostile lines (MCI, Shatel). */
  gentle: {
    mode: 'tls',
    tries: 2,
    minSuccesses: 1,
    timeoutMs: 5000,
    workers: 20,
    requireWs: false,
    stabilityMs: 0,
    requireHttp: true,
    maxLatencyMs: 2200,
    maxLossPct: 50,
    rateLimitPerSec: 12,
    minDelayMs: 40,
    topN: 10,
    minScore: 35,
  },
  /** Default balance between speed and accuracy. */
  standard: {
    mode: 'tls',
    tries: 3,
    minSuccesses: 2,
    timeoutMs: 4000,
    workers: 50,
    requireWs: false,
    stabilityMs: 0,
    requireHttp: true,
    maxLatencyMs: 1800,
    maxLossPct: 50,
    rateLimitPerSec: 0,
    minDelayMs: 0,
    topN: 20,
    minScore: 45,
  },
  /** Fast sweep: one shot per address, verify the survivors afterwards. */
  fast: {
    mode: 'tcp',
    tries: 1,
    minSuccesses: 1,
    timeoutMs: 2500,
    workers: 200,
    requireWs: false,
    stabilityMs: 0,
    requireHttp: false,
    maxLatencyMs: 2500,
    maxLossPct: 100,
    topN: 50,
    minScore: 10,
  },
  /** Strict: only addresses that survive DPI sensors and pass TLS+HTTP+WS. */
  strict: {
    mode: 'http',
    tries: 4,
    minSuccesses: 3,
    timeoutMs: 4000,
    workers: 40,
    requireWs: true,
    wsPath: '/',
    stabilityMs: 1500,
    requireHttp: true,
    maxLatencyMs: 1200,
    maxLossPct: 25,
    topN: 20,
    minScore: 60,
  },

  /**
   * Irancell (mobile, CGNAT). The operator caps *new sessions per second* per subscriber and
   * black-holes the SYN past it, so the failure is a timeout on a line that is fine — not a
   * dropped handshake (#56, #75). Hence: few workers, a global rate cap, one success needed,
   * and a long timeout to survive the jitter. Handshake-only (`tcp`): the TLS/HTTP gates fail
   * on this network for reasons that have nothing to do with the address. The numbers are the
   * ones `test/operator-profiles.test.ts` runs against a model of the same network.
   */
  irancell: {
    mode: 'tcp',
    tries: 3,
    minSuccesses: 1,
    timeoutMs: 6000,
    workers: 12,
    requireHttp: false,
    requireWs: false,
    stabilityMs: 0,
    maxLatencyMs: 2500,
    maxLossPct: 60,
    rateLimitPerSec: 12,
    minDelayMs: 40,
    adaptiveBackoff: true,
    topN: 5,
    minScore: 35,
  },

  /** MCI / Hamrah-e Aval: the same CGNAT shape, plus DPI resets on a burst (#58, #62). */
  mci: {
    mode: 'tcp',
    tries: 3,
    minSuccesses: 1,
    timeoutMs: 6000,
    workers: 12,
    requireHttp: false,
    requireWs: false,
    stabilityMs: 0,
    maxLatencyMs: 3000,
    maxLossPct: 60,
    rateLimitPerSec: 10,
    minDelayMs: 60,
    adaptiveBackoff: true,
    topN: 5,
    minScore: 35,
  },

  /**
   * MobinNet fiber (PPPoE behind a cheap ONU). The ONU's table is small enough that a burst
   * fills it and takes the whole home down until it recovers (#25, #96), and a broken PMTUD
   * turns a large transfer into a stall — so the sweep stays small and the speed phase is
   * given a longer budget instead of a smaller one.
   */
  mobin: {
    mode: 'tcp',
    tries: 2,
    minSuccesses: 1,
    timeoutMs: 6000,
    workers: 12,
    requireHttp: false,
    requireWs: false,
    stabilityMs: 0,
    maxLatencyMs: 2500,
    maxLossPct: 60,
    rateLimitPerSec: 12,
    minDelayMs: 40,
    adaptiveBackoff: true,
    speedBytes: 4_000_000,
    speedTimeoutMs: 6000,
    topN: 8,
    minScore: 35,
  },
};

/**
 * Preset aliases: the names a user types for a network, mapped to the profile for it. The
 * spellings with a dash or a space (`mobin-net`, `hamrah e aval`) work too — the key is
 * normalised before lookup.
 */
const PRESET_ALIASES: Record<string, string> = {
  iran: 'gentle',
  ir: 'gentle',
  irancell: 'irancell',
  mtn: 'irancell',
  mci: 'mci',
  hamrah: 'mci',
  hamraheaval: 'mci',
  hamrahaval: 'mci',
  mobin: 'mobin',
  mobinnet: 'mobin',
};

export function applyPreset(name: string): Partial<ScanConfig> | null {
  const key = name.trim().toLowerCase().replace(/[\s_-]/g, '');
  return PRESETS[PRESET_ALIASES[key] ?? key] ?? null;
}
