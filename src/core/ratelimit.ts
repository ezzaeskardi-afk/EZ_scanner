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

interface WatchdogOptions {
  /**
   * Canaries in `host:port` form. Read on every check, so a runtime
   * `configure({canaryHost})` takes effect immediately instead of being frozen at
   * construction time (which is how the setting used to be silently ignored).
   */
  canaries?: () => string[];
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  /** Only probe while this returns true (i.e. a scan is running). */
  enabled?: () => boolean;
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
const DEFAULT_CANARIES = ['1.1.1.1:443', '8.8.8.8:53', '9.9.9.9:443'];

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
   * Operator-supplied canaries win outright: an Iranian line that blocks
   * 1.1.1.1/8.8.8.8 would otherwise park a healthy scan forever, because "any canary
   * answered = line is up" can never be satisfied.
   */
  get canaries(): string[] {
    const custom = (this.opts.canaries?.() ?? []).filter(Boolean);
    return custom.length ? [...new Set(custom)] : DEFAULT_CANARIES;
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

  /** Runs one round-trip check; returns true when at least one canary answered. */
  async check(): Promise<boolean> {
    this.inFlight = true;
    let anyOk = false;
    const canaries = this.canaries;
    for (const canary of canaries) {
      const [host, portStr] = canary.split(':');
      try {
        const conn = await tcpConnect(host, Number(portStr || 443), { timeoutMs: this.timeoutMs });
        conn.socket.destroy();
        anyOk = true;
        break;
      } catch {
        /* try the next canary */
      }
    }
    this.inFlight = false;
    this.state.checks += 1;
    this.state.lastCheckAt = Date.now();
    this.state.canaries = canaries;
    if (anyOk) {
      this.consecutiveFailures = 0;
      this.state.failures = 0;
      if (this.state.offline) {
        this.state = { ...this.state, offline: false, message: 'line is back' };
        this.emit('change', this.state);
      } else {
        this.state = { ...this.state, offline: false, message: 'ok' };
      }
    } else {
      this.consecutiveFailures += 1;
      this.state.failures = this.consecutiveFailures;
      if (!this.state.offline && this.consecutiveFailures >= this.failureThreshold) {
        this.state = {
          ...this.state,
          offline: true,
          message: `no route to any canary (${canaries.join(', ')}) — pausing scan`,
        };
        this.emit('change', this.state);
      }
    }
    return anyOk;
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
