/**
 * Scan orchestrator.
 *
 * Responsibilities:
 *  - expand a source into concrete addresses (`buildTargets`);
 *  - run the probe phase with a worker pool, global rate limit and adaptive backoff;
 *  - re-check the line with a watchdog and park the scan if the internet dies;
 *  - speed-test/upload-test the best survivors;
 *  - persist a resumable snapshot, so a scan can be closed and continued later.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Emitter, runPool, sleep } from './events.ts';
import { buildTargets, splitHostPort } from './ipsrc.ts';
import { measureDownload, measureUpload, probeOnce } from './probe.ts';
import { AdaptiveBackoff, NetworkWatchdog, TokenBucket, type NetworkState } from './ratelimit.ts';
import {
  FAILURE_SAMPLE_LIMIT,
  createResult,
  finalize,
  finalizeAll,
  recordAttempt,
  sortResults,
  type SortKey,
} from './scoring.ts';
import {
  DEFAULT_CONFIG,
  type IpResult,
  type LogLine,
  type ScanConfig,
  type ScanStats,
  type SessionMeta,
  type SessionSnapshot,
  type SourceSpec,
} from './types.ts';

export type ScannerState = 'idle' | 'expanding' | 'running' | 'paused' | 'offline' | 'stopping' | 'done' | 'stopped';

interface ScannerEvents {
  progress: ScanStats;
  result: IpResult;
  log: LogLine;
  network: { offline: boolean; message: string };
  phase: { phase: ScanStats['phase']; message: string };
  state: { state: ScannerState; stats: ScanStats };
  done: { stats: ScanStats; results: IpResult[] };
}

interface StartOptions {
  resumeFrom?: SessionSnapshot;
  /** Applied on top of the snapshot config when resuming. */
  configOverride?: Partial<ScanConfig>;
  /** Explicit address list, bypassing source expansion (used by "rescan my list"). */
  targets?: string[];
  label?: string;
  /** Skip the speed/upload phases even when the config enables them. */
  skipSpeed?: boolean;
}

function initialStats(): ScanStats {
  return {
    phase: 'idle',
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    healthy: 0,
    startedAt: 0,
    elapsedMs: 0,
    rate: 0,
    etaMs: 0,
    inflight: 0,
    paused: false,
    backoffFactor: 1,
    offline: false,
    message: '',
    failuresByKind: {},
  };
}

export function defaultDataDir(): string {
  return process.env.EZSCAN_DATA_DIR ?? join(homedir(), '.ez-scanner');
}

export function resultKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

export class Scanner extends Emitter<ScannerEvents> {
  config: ScanConfig = { ...DEFAULT_CONFIG };
  source: SourceSpec = { kind: 'cloudflare', limit: 5000 };
  readonly results = new Map<string, IpResult>();
  /** Bounded sample of unreachable addresses, for "why is everything red?" */
  readonly failures: IpResult[] = [];
  targets: string[] = [];
  logs: LogLine[] = [];
  sessionId: string = randomUUID();
  label = '';
  createdAt = Date.now();

  private cursor = 0;
  private abort = new AbortController();
  private paused = false;
  private running = false;
  private phaseRunning = false;
  private bucket: TokenBucket;
  private backoff = new AdaptiveBackoff();
  private watchdog: NetworkWatchdog;
  private stats: ScanStats = initialStats();
  private samples: Array<{ at: number; done: number }> = [];
  private ticker: NodeJS.Timeout | null = null;
  private lastSnapshotAt = 0;
  readonly dataDir: string;

  constructor(dataDir: string = defaultDataDir()) {
    super();
    this.dataDir = dataDir;
    this.bucket = new TokenBucket(this.config.rateLimitPerSec);
    this.watchdog = new NetworkWatchdog({
      // Read through a getter, so `configure({canaryHost})` from the GUI/CLI actually
      // reaches the watchdog (a constructor-time snapshot silently ignored it).
      canaries: () => this.canaryList(),
      enabled: () => this.running && this.config.autoPauseOnNetworkLoss,
    });
    this.watchdog.on('change', (state) => {
      this.stats.offline = state.offline;
      this.log(state.offline ? 'warn' : 'ok', `network: ${state.message}`);
      this.emit('network', { offline: state.offline, message: state.message });
      this.emit('state', { state: this.getState(), stats: this.stats });
    });
  }

  /** Canaries for the line watchdog: the operator's own endpoint wins, else the defaults. */
  private canaryList(): string[] {
    return this.config.canaryHost ? [`${this.config.canaryHost}:${this.config.canaryPort}`] : [];
  }

  /* --------------------------------- state ---------------------------------- */

  get state(): ScannerState {
    if (this.phaseRunning) {
      if (this.watchdog.state.offline) return 'offline';
      return this.paused ? 'paused' : 'running';
    }
    return this.stats.phase === 'done' ? 'done' : this.stats.phase === 'stopped' ? 'stopped' : 'idle';
  }

  getState(): ScannerState {
    return this.state;
  }

  getStats(): ScanStats {
    return { ...this.stats, elapsedMs: this.stats.startedAt ? Date.now() - this.stats.startedAt : 0 };
  }

  getLogs(): LogLine[] {
    return [...this.logs];
  }

  /** Live line-health state from the watchdog. */
  getNetwork(): NetworkState {
    return { ...this.watchdog.state };
  }

  getResults(
    sort: SortKey = 'score',
    filter: { healthyOnly?: boolean; minScore?: number; includeFailures?: boolean } = {},
  ): IpResult[] {
    let list = [...this.results.values()];
    if (filter.healthyOnly) list = list.filter((r) => r.healthy);
    if (typeof filter.minScore === 'number') list = list.filter((r) => r.score >= filter.minScore!);
    const sorted = sortResults(list, sort);
    if (!filter.includeFailures) return sorted;
    return [...sorted, ...sortResults(this.failures.filter((f) => !this.results.has(resultKey(f.ip, f.port))), sort)];
  }

  /** Failure samples plus the aggregate breakdown. */
  getFailures(): { samples: IpResult[]; byKind: Record<string, number> } {
    return { samples: [...this.failures], byKind: { ...this.stats.failuresByKind } };
  }

  configure(config: Partial<ScanConfig>, source?: SourceSpec): void {
    if (this.running) throw new Error('cannot change configuration while a scan is running');
    this.config = { ...this.config, ...config };
    if (source) this.source = source;
    this.bucket.setRate(this.config.rateLimitPerSec);
  }

  log(level: LogLine['level'], text: string): void {
    const line: LogLine = { at: Date.now(), level, text };
    this.logs.push(line);
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    this.emit('log', line);
  }

  /* --------------------------------- control -------------------------------- */

  /** Runs a full scan; resolves when the scan ends or is stopped. */
  async start(opts: StartOptions = {}): Promise<void> {
    if (this.phaseRunning) throw new Error('a scan is already running');
    this.phaseRunning = true;
    this.abort = new AbortController();
    this.samples = [];
    this.backoff.reset();
    this.bucket.setRate(this.config.rateLimitPerSec);
    this.stats = { ...initialStats(), startedAt: Date.now(), phase: 'expanding' };

    if (opts.resumeFrom) {
      this.restore(opts.resumeFrom);
      if (opts.configOverride) this.config = { ...this.config, ...opts.configOverride };
      this.log('info', `resuming session ${this.sessionId.slice(0, 8)} at ${this.cursor}/${this.targets.length}`);
    } else {
      this.results.clear();
      this.failures.length = 0;
      this.logs = [];
      this.sessionId = randomUUID();
      this.createdAt = Date.now();
      this.log('info', `probe mode=${this.config.mode} port=${this.config.port} sni=${this.config.sni || '(none)'}`);
    }
    this.label = opts.label ?? (this.label || `scan ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    this.running = true;
    this.startTicker();
    // Fresh scan, fresh line state: the previous scan's "offline" verdict must not
    // survive into this one (it would show a line-down banner on a working line, and
    // with the watchdog disabled it would never be corrected).
    this.watchdog.reset();
    this.watchdog.start();

    try {
      if (opts.targets?.length) {
        this.targets = opts.targets;
        this.cursor = 0;
        this.stats.total = this.targets.length;
        this.log('info', `using ${this.targets.length} explicit addresses`);
      } else if (!opts.resumeFrom) {
        await this.expand();
      }
      this.stats.total = this.targets.length;
      this.emit('state', { state: this.state, stats: this.stats });

      if (this.abort.signal.aborted) throw new Error('stopped');
      await this.runPhase('probe', 'probing addresses', () => this.probePhase());
      if (this.abort.signal.aborted) throw new Error('stopped');

      if (!opts.skipSpeed && (this.config.measureSpeed || this.config.measureUpload)) {
        await this.runPhase('speed', 'measuring throughput', () => this.speedPhase());
      }
      if (this.abort.signal.aborted) throw new Error('stopped');

      this.stats.phase = 'done';
      this.stats.healthy = finalizeAll([...this.results.values()], this.config).filter((r) => r.healthy).length;
      this.stats.message = `done: ${this.stats.healthy} healthy of ${this.stats.total}`;
      this.log('ok', this.stats.message);
    } catch (err) {
      if (!this.abort.signal.aborted) {
        this.log('error', `scan error: ${(err as Error).message}`);
      }
      this.stats.phase = 'stopped';
      this.stats.message = this.abort.signal.aborted ? 'stopped by user' : `aborted: ${(err as Error).message}`;
    } finally {
      // One final verdict pass over everything we collected.
      finalizeAll([...this.results.values()], this.config);
      this.stats.healthy = [...this.results.values()].filter((r) => r.healthy).length;
      this.running = false;
      this.phaseRunning = false;
      this.paused = false;
      this.stopTicker();
      this.watchdog.stop();
      this.stats.elapsedMs = Date.now() - (this.stats.startedAt || Date.now());
      this.stats.rate = 0;
      this.stats.etaMs = 0;
      this.stats.inflight = 0;
      this.emit('progress', this.getStats());
      this.emit('state', { state: this.state, stats: this.stats });
      try {
        await this.saveSnapshot();
      } catch (err) {
        this.log('warn', `could not save session: ${(err as Error).message}`);
      }
      this.emit('done', { stats: this.getStats(), results: this.getResults('score') });
    }
  }

  pause(): void {
    if (!this.phaseRunning || this.paused) return;
    this.paused = true;
    this.stats.paused = true;
    this.stats.message = 'paused';
    this.log('info', 'scan paused');
    this.emit('state', { state: this.state, stats: this.stats });
  }

  resume(): void {
    if (!this.phaseRunning || !this.paused) return;
    this.paused = false;
    this.stats.paused = false;
    this.stats.message = '';
    this.log('info', 'scan resumed');
    this.emit('state', { state: this.state, stats: this.stats });
  }

  async stop(): Promise<void> {
    if (!this.phaseRunning) return;
    this.log('warn', 'stopping…');
    this.stats.message = 'stopping…';
    this.abort.abort();
    this.paused = false;
    this.stats.paused = false;
  }

  /** Re-probes or re-runs the speed test on a specific subset of results. */
  async retest(keys: string[], mode: 'probe' | 'speed' = 'speed'): Promise<IpResult[]> {
    const list = keys.map((k) => this.results.get(k)).filter((r): r is IpResult => Boolean(r));
    if (!list.length) return [];
    const local = new AbortController();
    if (mode === 'probe') {
      await runPool(list, Math.max(1, Math.min(this.config.workers, 20)), async (r) => {
        const fresh = createResult(r.ip, r.port, r.sni);
        const tries = Math.max(1, this.config.tries);
        for (let t = 0; t < tries; t++) {
          await this.bucket.acquire(local.signal);
          const attempt = await probeOnce({ ip: r.ip, port: r.port, sni: r.sni }, this.config, local.signal, r.sni);
          recordAttempt(fresh, attempt);
        }
        Object.assign(r, finalize(fresh, this.config));
        this.emit('result', r);
      });
    } else {
      await runPool(list, Math.max(1, Math.min(8, this.config.workers)), async (r) => {
        const down = await measureDownload({ ip: r.ip, port: r.port, sni: r.sni }, this.config, local.signal);
        if (down.ok) r.downMbps = down.mbps;
        if (this.config.measureUpload) {
          const up = await measureUpload({ ip: r.ip, port: r.port, sni: r.sni }, this.config, local.signal);
          if (up.ok) r.upMbps = up.mbps;
        }
        finalizeAll([...this.results.values()], this.config);
        this.emit('result', r);
      });
    }
    this.emit('state', { state: this.state, stats: this.stats });
    return list;
  }

  /* ---------------------------------- phases -------------------------------- */

  private async runPhase(phase: ScanStats['phase'], message: string, fn: () => Promise<void>): Promise<void> {
    this.stats.phase = phase;
    this.emit('phase', { phase, message });
    this.emit('state', { state: this.state, stats: this.stats });
    await fn();
  }

  private async expand(): Promise<void> {
    const result = await buildTargets(this.source, {
      count: this.source.limit ?? 0,
      family: this.config.family,
      seed: this.source.seed,
    });
    this.targets = result.targets;
    this.cursor = 0;
    this.stats.total = this.targets.length;
    for (const note of result.notes) this.log('info', note);
    for (const err of result.errors.slice(0, 5)) this.log('warn', `source skipped: ${err}`);
    if (result.errors.length > 5) this.log('warn', `…and ${result.errors.length - 5} more invalid source entries`);
    this.log('ok', `source ready: ${this.targets.length} addresses from ${result.ranges || result.resolved} ranges/domains`);
    if (!this.targets.length) throw new Error('no target addresses — check the source settings');
  }

  private pickSni(index: number): string {
    if (this.config.sniPool.length) return this.config.sniPool[index % this.config.sniPool.length];
    return this.config.sni;
  }

  private async probePhase(): Promise<void> {
    const total = this.targets.length;
    const workers = Math.max(1, Math.min(this.config.workers, Math.max(1, total)));
    // A resumed session continues its counter where the snapshot left it, so progress
    // never drops back to 0 the moment the next address is probed.
    let completed = Math.min(this.stats.done, total);
    /** Addresses a worker has taken but not finished — rewound if the scan is stopped. */
    const inflight = new Set<number>();

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.abort.signal.aborted) return;
        while (this.paused && !this.abort.signal.aborted) await sleep(150, this.abort.signal);
        if (this.abort.signal.aborted) return;
        if (this.config.autoPauseOnNetworkLoss && this.watchdog.state.offline) {
          this.stats.message = 'waiting for the line to come back…';
          this.emit('progress', this.getStats());
          const back = await this.watchdog.waitUntilOnline(this.abort.signal);
          if (!back) return;
          this.stats.message = '';
          continue;
        }
        // The cursor must not run past the end: overshooting it used to consume
        // addresses that were never probed, so a resume skipped them.
        if (this.cursor >= total) return;
        const index = this.cursor++;
        inflight.add(index);
        const raw = this.targets[index];
        const { host: ip, port } = splitHostPort(raw, this.config.port);
        const key = resultKey(ip, port);

        this.stats.inflight += 1;
        await this.bucket.acquire(this.abort.signal);
        if (this.abort.signal.aborted) {
          this.stats.inflight -= 1;
          return;
        }

        const result = createResult(ip, port, this.config.sni);
        const tries = Math.max(1, Math.min(10, this.config.tries));
        const need = Math.max(1, Math.min(this.config.minSuccesses, tries));
        for (let attempt = 0; attempt < tries; attempt++) {
          if (this.abort.signal.aborted) break;
          const sni = this.pickSni(attempt);
          const probed = await probeOnce({ ip, port, sni }, this.config, this.abort.signal, sni);
          recordAttempt(result, probed);
          this.backoff.record(probed.ok);
          if (this.config.earlyExit && result.successes >= need) break;
        }
        this.stats.inflight -= 1;
        // Stopped mid-probe with nothing to show: that is not a failure, and the address
        // stays unconsumed (the cursor is rewound below) so a resume probes it again
        // instead of recording a fake `aborted` failure and skipping it forever.
        if (this.abort.signal.aborted && result.successes === 0) return;
        inflight.delete(index);
        finalize(result, this.config);
        this.backoff.record(result.successes > 0);

        const existing = this.results.get(key);
        if (result.successes > 0) {
          if (existing) {
            // Same address reached twice (duplicate in a pasted list) — merge.
            existing.attempts += result.attempts;
            existing.successes += result.successes;
            existing.latencies.push(...result.latencies);
            finalize(existing, this.config);
            this.emit('result', existing);
          } else {
            this.results.set(key, result);
            if (result.healthy) this.stats.healthy += 1;
            this.emit('result', result);
          }
        }

        if (result.successes === 0) {
          this.stats.failed += 1;
          for (const [kind, count] of Object.entries(result.errorKinds ?? { other: 1 })) {
            this.stats.failuresByKind[kind] = (this.stats.failuresByKind[kind] ?? 0) + count;
          }
          if (this.failures.length < FAILURE_SAMPLE_LIMIT) {
            this.failures.push(result);
            this.emit('result', result);
          }
        }
        completed += 1;
        this.stats.done = completed;
        this.stats.ok = this.results.size;

        // Adaptive backoff has to bite even when the configured delay is 0,
        // otherwise a spiking failure ratio slows nothing down at all.
        const baseDelay = this.config.minDelayMs;
        const factor = this.config.adaptiveBackoff ? this.backoff.factor : 1;
        const delay = baseDelay + (factor > 1 ? Math.round((factor - 1) * (30 + baseDelay)) : 0);
        this.stats.backoffFactor = factor;
        if (delay > 0) await sleep(delay, this.abort.signal);
      }
    };

    this.log('info', `probing ${total} addresses with ${workers} workers (timeout ${this.config.timeoutMs}ms, tries ${this.config.tries})`);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (inflight.size) this.cursor = Math.min(this.cursor, Math.min(...inflight));
  }

  private async speedPhase(): Promise<void> {
    const healthy = sortResults([...this.results.values()].filter((r) => r.healthy), 'score');
    const limit = this.config.topN > 0 ? this.config.topN : healthy.length;
    const candidates = healthy.slice(0, Math.max(0, limit));
    if (!candidates.length) {
      this.log('warn', 'no healthy address to speed-test');
      return;
    }
    this.log('info', `speed-testing top ${candidates.length} addresses`);
    const concurrency = Math.max(1, Math.min(8, this.config.workers));
    let finished = 0;

    if (this.config.measureSpeed) {
      await runPool(
        candidates,
        concurrency,
        async (r) => {
          if (this.abort.signal.aborted) return;
          const down = await measureDownload({ ip: r.ip, port: r.port, sni: r.sni }, this.config, this.abort.signal);
          if (down.ok) r.downMbps = down.mbps;
          finalizeAll([...this.results.values()], this.config);
          this.emit('result', r);
          finished += 1;
          this.stats.message = `speed ${finished}/${candidates.length}`;
          this.emit('progress', this.getStats());
        },
        this.abort.signal,
      );
    }

    if (this.config.measureUpload && !this.abort.signal.aborted) {
      this.stats.phase = 'upload';
      const upCandidates = sortResults(candidates, 'down').slice(0, Math.max(5, Math.ceil(candidates.length / 2)));
      await runPool(
        upCandidates,
        Math.max(1, Math.min(4, this.config.workers)),
        async (r) => {
          if (this.abort.signal.aborted) return;
          const up = await measureUpload({ ip: r.ip, port: r.port, sni: r.sni }, this.config, this.abort.signal);
          if (up.ok) r.upMbps = up.mbps;
          finalizeAll([...this.results.values()], this.config);
          this.emit('result', r);
        },
        this.abort.signal,
      );
    }

    finalizeAll([...this.results.values()], this.config);
    this.stats.healthy = [...this.results.values()].filter((r) => r.healthy).length;
  }

  /* -------------------------------- progress -------------------------------- */

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      const now = Date.now();
      this.samples.push({ at: now, done: this.stats.done });
      while (this.samples.length > 2 && now - this.samples[0].at > 15_000) this.samples.shift();
      const first = this.samples[0];
      const windowSec = first ? (now - first.at) / 1000 : 0;
      const rate = windowSec > 0.5 ? (this.stats.done - first.done) / windowSec : 0;
      this.stats.rate = Math.round(rate * 10) / 10;
      const remaining = Math.max(0, this.stats.total - this.stats.done);
      this.stats.etaMs = rate > 0.2 ? Math.round((remaining / rate) * 1000) : 0;
      this.stats.elapsedMs = now - (this.stats.startedAt || now);
      this.emit('progress', this.getStats());
      if (now - this.lastSnapshotAt > 15_000 && this.stats.done > 0) {
        void this.saveSnapshot().catch(() => {});
      }
    }, 500);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /* --------------------------------- sessions ------------------------------- */

  private sessionDir(): string {
    return join(this.dataDir, 'sessions');
  }

  snapshot(updateTimestamp = true): SessionSnapshot {
    return {
      version: 1,
      id: this.sessionId,
      label: this.label,
      createdAt: this.createdAt,
      updatedAt: updateTimestamp ? Date.now() : this.createdAt,
      config: this.config,
      source: this.source,
      targets: this.targets,
      cursor: this.cursor,
      results: [...this.results.values()],
      failures: this.failures.slice(0, FAILURE_SAMPLE_LIMIT),
      stats: this.getStats(),
      logs: this.logs.slice(-100),
    };
  }

  restore(snapshot: SessionSnapshot): void {
    this.sessionId = snapshot.id;
    this.label = snapshot.label;
    this.createdAt = snapshot.createdAt;
    this.config = { ...DEFAULT_CONFIG, ...snapshot.config };
    this.source = snapshot.source;
    this.targets = snapshot.targets;
    this.cursor = Math.min(snapshot.cursor, snapshot.targets.length);
    this.logs = [...(snapshot.logs ?? [])];
    this.results.clear();
    for (const r of snapshot.results) this.results.set(resultKey(r.ip, r.port), r);
    this.failures.length = 0;
    for (const f of snapshot.failures ?? []) this.failures.push(f);
    this.stats = {
      ...initialStats(),
      ...snapshot.stats,
      phase: 'probe',
      total: this.targets.length,
      done: this.cursor,
      paused: false,
      inflight: 0,
      ok: snapshot.results.length,
      failuresByKind: { ...(snapshot.stats?.failuresByKind ?? {}) },
    };
    this.bucket.setRate(this.config.rateLimitPerSec);
  }

  async saveSnapshot(): Promise<string> {
    const dir = this.sessionDir();
    await mkdir(dir, { recursive: true });
    this.lastSnapshotAt = Date.now();
    const snapshot = this.snapshot();
    snapshot.updatedAt = this.lastSnapshotAt;
    const file = join(dir, `${this.sessionId}.json`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
    await rename(tmp, file);
    const meta: SessionMeta = {
      id: this.sessionId,
      label: this.label || this.sessionId.slice(0, 8),
      createdAt: this.createdAt,
      updatedAt: snapshot.updatedAt,
      total: this.stats.total,
      done: this.stats.done,
      healthy: this.stats.healthy,
      phase: this.stats.phase,
      file,
    };
    await writeFile(join(dir, `${this.sessionId}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
    return file;
  }

  async listSessions(): Promise<SessionMeta[]> {
    const dir = this.sessionDir();
    try {
      const files = await readdir(dir);
      const metas: SessionMeta[] = [];
      for (const f of files) {
        if (!f.endsWith('.meta.json')) continue;
        try {
          metas.push(JSON.parse(await readFile(join(dir, f), 'utf8')) as SessionMeta);
        } catch {
          /* skip corrupt metadata */
        }
      }
      return metas.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  async loadSnapshot(idOrPath: string): Promise<SessionSnapshot> {
    const dir = this.sessionDir();
    const candidates = [idOrPath, join(dir, `${idOrPath}.json`), join(dir, idOrPath)];
    let lastError: Error | null = null;
    for (const candidate of new Set(candidates)) {
      try {
        const parsed = JSON.parse(await readFile(candidate, 'utf8')) as SessionSnapshot;
        if (!parsed || !Array.isArray(parsed.targets)) throw new Error('not a session snapshot');
        return parsed;
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw new Error(`session "${idOrPath}" not found: ${lastError?.message ?? 'unknown error'}`);
  }

  async deleteSession(id: string): Promise<void> {
    const dir = this.sessionDir();
    for (const suffix of ['.json', '.meta.json']) {
      try {
        await unlink(join(dir, `${id}${suffix}`));
      } catch {
        /* already gone */
      }
    }
  }

  /** Imports an external snapshot file (used by `ezscan resume --file`). */
  async importSnapshot(file: string): Promise<SessionSnapshot> {
    return this.loadSnapshot(file);
  }
}
