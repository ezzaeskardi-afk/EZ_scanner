/**
 * Turning raw attempts into a verdict.
 *
 * The important design decision (and the fix for the "everything is red"
 * reports): every gate is optional, and a gate that is switched off contributes
 * a neutral value instead of a failure. Only gates the user actually enabled can
 * reject an address.
 */
import type { IpResult, ProbeAttempt, ScanConfig, SpeedTrust } from './types.ts';

/** How many failure samples a finished scan keeps for diagnostics. */
export const FAILURE_SAMPLE_LIMIT = 300;

export function createResult(ip: string, port: number, sni: string): IpResult {
  const now = Date.now();
  return {
    ip,
    port,
    sni,
    attempts: 0,
    successes: 0,
    lossPct: 0,
    latencies: [],
    medianLatency: 0,
    bestLatency: 0,
    jitter: 0,
    httpStatus: 0,
    wsOk: null,
    stable: null,
    stabilityMs: 0,
    downMbps: 0,
    upMbps: 0,
    downTrust: 'untested',
    upTrust: 'untested',
    colo: '',
    score: 0,
    healthy: false,
    reasons: [],
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

export function recordAttempt(result: IpResult, attempt: ProbeAttempt): void {
  result.attempts += 1;
  result.lastSeenAt = Date.now();
  if (attempt.ok) {
    result.successes += 1;
    result.latencies.push(Math.round(attempt.latencyMs));
  } else if (attempt.error) {
    result.lastError = attempt.error;
    result.errorKinds = result.errorKinds ?? {};
    result.errorKinds[attempt.error] = (result.errorKinds[attempt.error] ?? 0) + 1;
  }
  if (attempt.httpStatus) result.httpStatus = attempt.httpStatus;
  if (attempt.colo) result.colo = attempt.colo;
  if (typeof attempt.wsOk === 'boolean') result.wsOk = attempt.wsOk;
  if (typeof attempt.stable === 'boolean') result.stable = attempt.stable;
  if (attempt.idleMs) result.stabilityMs = attempt.idleMs;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

interface ScoreParts {
  latency: number;
  reliability: number;
  dpi: number;
  http: number;
  speed: number;
}

const WEIGHTS = { latency: 0.5, reliability: 0.25, dpi: 0.1, http: 0.05, speed: 0.1 };

function scoreParts(result: IpResult, cfg: ScanConfig, bestMbps: number): ScoreParts {
  const reference = Math.max(cfg.maxLatencyMs, 100);
  const latency = clamp01((reference - result.medianLatency) / reference);
  const reliability = clamp01(1 - result.lossPct / 100) * clamp01(result.successes / Math.max(1, result.attempts) + 0.25);
  const dpi =
    cfg.stabilityMs > 0
      ? result.stable
        ? 1
        : 0
      : result.stable === false
        ? 0.25
        : 0.7;
  const http =
    !cfg.requireHttp && cfg.mode !== 'http'
      ? 0.7
      : result.httpStatus >= 200 && result.httpStatus < 400
        ? 1
        : result.httpStatus > 0
          ? 0.6
          : 0;
  // Only a trusted transfer has a rate: everything else contributes a part of 0 and it is the
  // *weight* (below) that decides whether that 0 counts against the address.
  const speed =
    result.downTrust === 'measured' && bestMbps > 0 ? clamp01(result.downMbps / bestMbps) : 0;
  return { latency, reliability, dpi, http, speed };
}

/**
 * The trusts that are a verdict about the path, and therefore may not be skipped when scoring.
 *
 * "No measurement" and "the measurement failed" are not the same answer to "how fast is this
 * address?", and skipping the speed term for both made them interchangeable: an address whose
 * transfer the line cut had the term dropped, while the address that finished its transfer and
 * tested *slow* had it counted — so the one that could not be measured outranked the one that
 * could. These three are evidence (the path would not carry a payload the endpoint had agreed to
 * send), so they get the weight with a part of 0 and can never beat a measured address.
 */
const DISTRUSTED: ReadonlySet<SpeedTrust> = new Set<SpeedTrust>(['partial', 'cut', 'stalled']);

/** Computes score/verdict for one result; speed normalisation needs the batch. */
export function finalize(result: IpResult, cfg: ScanConfig, bestMbps = 0): IpResult {
  const reasons: string[] = [];
  result.medianLatency = median(result.latencies);
  result.bestLatency = result.latencies.length ? Math.min(...result.latencies) : 0;
  result.jitter = Math.round(stddev(result.latencies));
  result.lossPct = result.attempts ? Math.round((1 - result.successes / result.attempts) * 100) : 100;

  const parts = scoreParts(result, cfg, bestMbps);
  // Only addresses that actually have a measurement take part in the speed
  // weighting — otherwise everything the speed phase skipped would look bad.
  //
  // `bestMbps > 0` means somebody in this batch completed a transfer, which is the only situation
  // in which the speed term is a *comparison*. Without it there is nothing to compare against — a
  // line that cut or stalled every transfer it was asked for looks like that for every address on
  // it, mobile and fiber alike — and the term is dropped for all of them rather than turning a
  // whole scan red over a fault none of these addresses caused.
  const speedWeight = bestMbps > 0 && (result.downTrust === 'measured' || DISTRUSTED.has(result.downTrust)) ? WEIGHTS.speed : 0;
  const totalWeight = WEIGHTS.latency + WEIGHTS.reliability + WEIGHTS.dpi + WEIGHTS.http + speedWeight;
  const weighted =
    parts.latency * WEIGHTS.latency +
    parts.reliability * WEIGHTS.reliability +
    parts.dpi * WEIGHTS.dpi +
    parts.http * WEIGHTS.http +
    parts.speed * speedWeight;
  result.score = Math.round((weighted / totalWeight) * 100);

  const minSuccesses = Math.max(1, Math.min(cfg.minSuccesses, Math.max(1, cfg.tries)));
  if (result.successes === 0) {
    const worst = result.errorKinds ? Object.entries(result.errorKinds).sort((a, b) => b[1] - a[1])[0] : null;
    reasons.push(worst ? `no successful attempt (${worst[0]} ×${worst[1]})` : 'no successful attempt');
  }
  else if (result.successes < minSuccesses) reasons.push(`successes ${result.successes} < ${minSuccesses}`);
  if (result.attempts > 0 && result.lossPct > cfg.maxLossPct) reasons.push(`loss ${result.lossPct}% > ${cfg.maxLossPct}%`);
  if (result.successes > 0 && result.medianLatency > cfg.maxLatencyMs) {
    reasons.push(`median ${result.medianLatency}ms > ${cfg.maxLatencyMs}ms`);
  }
  // The protocol gates can only judge what the probe actually did. `mode: tcp` stops at the
  // handshake, so HTTP/WS/idle-hold results do not exist for it — and scoring them anyway
  // rejected every reachable address in exactly the mode the CLI recommends for hostile
  // lines (`--mode tcp` with `requireHttp` left at its default): a sweep of 30 reachable
  // Cloudflare edges (90 ms, 0% loss) reported "30 reachable | 0 healthy", every row
  // thrown out with "HTTP check failed". The CLI already warns that tcp ignores these
  // gates; now the verdict agrees with it.
  const talksHttp = cfg.mode !== 'tcp';
  if (talksHttp && (cfg.mode === 'http' || cfg.requireHttp) && result.successes > 0 && !result.httpStatus) {
    reasons.push('HTTP check failed');
  }
  if (talksHttp && cfg.requireWs && result.wsOk !== true) reasons.push('WebSocket upgrade failed');
  if (talksHttp && cfg.stabilityMs > 0 && result.stable !== true) {
    reasons.push(`connection dropped during ${cfg.stabilityMs}ms idle hold`);
  }
  if (result.score < cfg.minScore) reasons.push(`score ${result.score} < ${cfg.minScore}`);

  result.healthy = reasons.length === 0;
  result.reasons = reasons;
  return result;
}

/**
 * Finalises a whole batch, normalising speed across it.
 *
 * The baseline is the fastest *trusted* download in the batch, so a number that may not rank an
 * address cannot raise the bar for the ones that may either.
 */
export function finalizeAll(results: IpResult[], cfg: ScanConfig): IpResult[] {
  const bestMbps = results.reduce((acc, r) => (r.downTrust === 'measured' ? Math.max(acc, r.downMbps || 0) : acc), 0);
  for (const r of results) finalize(r, cfg, bestMbps);
  return results;
}

/**
 * Gives a row restored from an older snapshot its verdict back.
 *
 * A snapshot written before throughput carried a verdict still holds numbers that were measured
 * and that the ranking used at the time, and the honest reading of one is `measured` — the same
 * reading that number got when it was written. Left as `untested`, a resumed session would quietly
 * drop the speed column from every row it had already paid for.
 */
export function adoptSnapshotTrust(result: IpResult): IpResult {
  if (result.downTrust === undefined) result.downTrust = result.downMbps > 0 ? 'measured' : 'untested';
  if (result.upTrust === undefined) result.upTrust = result.upMbps > 0 ? 'measured' : 'untested';
  return result;
}

export type SortKey = 'score' | 'latency' | 'loss' | 'down' | 'up' | 'ip' | 'first';

export function sortResults(results: IpResult[], key: SortKey = 'score'): IpResult[] {
  const copy = [...results];
  copy.sort((a, b) => {
    switch (key) {
      case 'latency':
        return (a.medianLatency || 1e9) - (b.medianLatency || 1e9);
      case 'loss':
        return a.lossPct - b.lossPct || (a.medianLatency || 1e9) - (b.medianLatency || 1e9);
      case 'down':
        return (b.downMbps || 0) - (a.downMbps || 0);
      case 'up':
        return (b.upMbps || 0) - (a.upMbps || 0);
      case 'ip':
        return a.ip.localeCompare(b.ip, undefined, { numeric: true });
      case 'first':
        return b.firstSeenAt - a.firstSeenAt;
      case 'score':
      default:
        return b.score - a.score || (a.medianLatency || 1e9) - (b.medianLatency || 1e9);
    }
  });
  return copy;
}
