/**
 * Traffic shaping and line-health detection.
 *
 * Iranian operators react to bursty scanning by dropping the whole link
 * (issues #25, #62, #96): the connection dies, the browser stops working and the
 * router needs a restart. Two independent defences live here:
 *   - a global token bucket plus a per-worker delay, which flattens the burst;
 *   - a watchdog that notices the line is gone and parks the scan until it is
 *     back, instead of hammering a dead link.
 */
import { Emitter, sleep } from './events.ts';
import { tcpConnect } from './net.ts';

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private rate: number;
  private readonly burst: number;

  constructor(ratePerSec: number, burst?: number) {
    this.rate = Math.max(0, ratePerSec);
    this.burst = Math.max(1, burst ?? Math.max(1, Math.ceil(this.rate)));
    this.tokens = this.burst;
  }

  setRate(ratePerSec: number): void {
    this.refill();
    this.rate = Math.max(0, ratePerSec);
  }

  get currentRate(): number {
    return this.rate;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    if (elapsed <= 0) return;
    this.last = now;
    if (this.rate <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
  }

  /** Resolves once a token is available. Unlimited when rate is 0. */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.rate <= 0) return;
    for (;;) {
      if (signal?.aborted) return;
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(5, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
      await sleep(waitMs, signal);
    }
  }

  reset(): void {
    this.tokens = this.burst;
    this.last = Date.now();
  }
}

/** Slows the sweep down when the failure ratio spikes, speeds back up when it recovers. */
export class AdaptiveBackoff {
  factor = 1;
  private ratio = 0;
  private readonly max: number;
  private readonly threshold: number;

  constructor(max = 8, threshold = 0.55) {
    this.max = max;
    this.threshold = threshold;
  }

  record(ok: boolean): void {
    this.ratio = this.ratio * 0.8 + (ok ? 0 : 1) * 0.2;
    if (this.ratio > this.threshold) this.factor = Math.min(this.max, this.factor * 1.25);
    else if (this.ratio < 0.25) this.factor = Math.max(1, this.factor / 1.3);
  }

  reset(): void {
    this.factor = 1;
    this.ratio = 0;
  }
}

type CanaryDial = (canary: string, timeoutMs: number) => Promise<void>;

export interface WatchdogOptions {
  /**
   * Canaries in `host:port` form. Read on every check, so a runtime
   * `configure({canaryHost})` takes effect immediately instead of being frozen at
   * construction time (which is how the setting used to be silently ignored).
   */
  canaries?: () => string[];
  /**
   * Tried after the configured canaries. Defaults to `DEFAULT_CANARIES`; pass `[]`
   * to watch nothing but the configured endpoints.
   */
  fallbackCanaries?: string[];
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  /** Only probe while this returns true (i.e. a scan is running). */
  enabled?: () => boolean;
  /**
   * How a canary is dialled; defaults to a raw TCP connect. The dial owns the timeout
   * (the default one passes `timeoutMs` to the connect) and rejects when the canary does
   * not answer, which is what the caller reads as "the line is down".
   *
   * Injectable because a *loopback* line cannot be made to drop a SYN: a port with
   * nothing behind it answers with a RST, and a refusal is deliberately counted as proof
   * the path is up. So a test that has to take a line down mid-scan replaces the dial;
   * the default one is exercised against real sockets in `ratelimit.test.ts`.
   */
  dial?: CanaryDial;
}

export interface NetworkState {
  offline: boolean;
  checks: number;
  failures: number;
  lastCheckAt: number;
  message: string;
  /** The canaries the last check actually used — shown so a blocked line is debuggable. */
  canaries: string[];
}

type WatchdogEvents = {
  change: NetworkState;
};

/** Built-in canaries, tried in order; the first success marks the line as up. */
export const DEFAULT_CANARIES = ['1.1.1.1:443', '8.8.8.8:53', '9.9.9.9:443'];

/**
 * Socket errors that *prove* the line works: a RST or a refusal came back, so the
 * packet left the machine, crossed the operator and a remote answered. The canary is
 * blocked or not listening — the scan has no reason to park over that.
 */
const REACHABLE_EVIDENCE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);

/**
 * Dialling a canary: connect, then hang up. Nothing is sent — the connect is the whole
 * question ("does anything at all answer on this path?"), and it is the cheapest way to
 * ask it without dragging a full probe into the watchdog.
 */
const dialCanary: CanaryDial = async (canary, timeoutMs) => {
  const [host, portStr] = canary.split(':');
  const conn = await tcpConnect(host, Number(portStr || 443), { timeoutMs });
  conn.socket.destroy();
};

/**
 * The watch list, configured canaries first and the built-ins behind them, deduped.
 * Order matters: the endpoint you care about decides as fast as possible, but a
 * canary the operator blocks can never park a healthy scan on its own.
 */
export function mergeCanaries(custom: string[], fallback: string[] = DEFAULT_CANARIES): string[] {
  const out: string[] = [];
  for (const entry of [...custom, ...fallback]) {
    const canary = (entry ?? '').trim();
    if (canary && !out.includes(canary)) out.push(canary);
  }
  return out;
}

export class NetworkWatchdog extends Emitter<WatchdogEvents> {
  state: NetworkState = { offline: false, checks: 0, failures: 0, lastCheckAt: 0, message: 'ok', canaries: [] };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private consecutiveFailures = 0;
  private readonly opts: WatchdogOptions;

  constructor(opts: WatchdogOptions = {}) {
    super();
    this.opts = opts;
  }

  /**
   * Configured canaries are tried first, the built-ins stay behind them. A line that
   * blocks 1.1.1.1 (Irancell/IR-MCI, and plenty of fiber ONUs) no longer parks a
   * healthy scan: the watch list falls through to 8.8.8.8 and 9.9.9.9, and any
   * answer — a completed connect *or* a refusal — means the path is up.
   */
  get canaries(): string[] {
    return mergeCanaries(this.opts.canaries?.() ?? [], this.opts.fallbackCanaries ?? DEFAULT_CANARIES);
  }

  get intervalMs(): number {
    return this.opts.intervalMs ?? 4000;
  }

  get timeoutMs(): number {
    return this.opts.timeoutMs ?? 2500;
  }

  get failureThreshold(): number {
    return this.opts.failureThreshold ?? 2;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      const enabled = this.opts.enabled ? this.opts.enabled() : true;
      if (enabled && !this.inFlight) await this.check();
      this.timer = setTimeout(tick, this.intervalMs);
    };
    // Check once immediately: waiting a whole interval left the first seconds of a scan
    // with no line state at all (and the GUI showing a stale "line: ok").
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Forgets the previous verdict. A new scan must not open with the last scan's
   * "line is down" banner: nothing has been checked yet, and the first check (which
   * runs immediately on `start()`) decides the state again.
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.state = { offline: false, checks: 0, failures: 0, lastCheckAt: 0, message: 'ok', canaries: [] };
  }

  /**
   * Runs one round-trip check; returns true when the line looks up.
   *
   * Every canary is offered a turn before the line is called down, and a refusal counts
   * as an answer (see `REACHABLE_EVIDENCE`). Worst case is one timeout per canary, which
   * is the interesting case anyway: a park is followed by `waitUntilOnline` polling, not
   * by tight retries.
   */
  async check(): Promise<boolean> {
    this.inFlight = true;
    const canaries = this.canaries;
    const dial = this.opts.dial ?? dialCanary;
    let connected = false;
    let refusedBy = '';
    for (const canary of canaries) {
      try {
        await dial(canary, this.timeoutMs);
        connected = true;
        break;
      } catch (err) {
        // A blocked or dead canary only speaks for itself — the loop keeps going, and a
        // refusal is already proof that the path works.
        if (REACHABLE_EVIDENCE.has((err as NodeJS.ErrnoException).code ?? '')) {
          refusedBy = canary;
          break;
        }
      }
    }
    this.inFlight = false;
    this.state.checks += 1;
    this.state.lastCheckAt = Date.now();
    this.state.canaries = canaries;
    if (connected || refusedBy) {
      const wasOffline = this.state.offline;
      this.consecutiveFailures = 0;
      this.state.failures = 0;
      const message = connected
        ? wasOffline
          ? 'line is back'
          : 'ok'
        : `${refusedBy} refused the connection — the path answered, treating the line as up`;
      this.state = { ...this.state, offline: false, message };
      if (wasOffline) this.emit('change', this.state);
    } else {
      this.consecutiveFailures += 1;
      this.state.failures = this.consecutiveFailures;
      if (!this.state.offline && this.consecutiveFailures >= this.failureThreshold) {
        this.state = {
          ...this.state,
          offline: true,
          message: `no answer from any canary (${canaries.join(', ')}) — pausing scan`,
        };
        this.emit('change', this.state);
      }
    }
    return connected || Boolean(refusedBy);
  }

  /** Waits until the line is reachable again (or the abort signal fires). */
  async waitUntilOnline(signal?: AbortSignal): Promise<boolean> {
    while (this.running && !signal?.aborted) {
      if (await this.check()) return true;
      await sleep(Math.max(1000, this.intervalMs), signal);
    }
    return false;
  }
}
