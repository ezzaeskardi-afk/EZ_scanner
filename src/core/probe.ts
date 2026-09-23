/**
 * The probe engine.
 *
 * One "attempt" walks exactly as far as the configuration asks:
 *
 *   connect ──► TLS handshake ──► HTTP/1.1 response ──► WS upgrade ──► idle hold
 *   (tcp)        (tls / http)       (requireHttp)        (requireWs)   (stabilityMs)
 *
 * Every gate is opt-in so a hostile/throttled line can be scanned with the
 * gentle path (handshake only) instead of failing everything (see README).
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { ProbeAttempt, ProbeErrorKind, ScanConfig, SpeedTrust } from './types.ts';
import {
  AbortedError,
  TimeoutError,
  destroy,
  drainBytes,
  holdIdle,
  readUntil,
  tcpConnect,
  tlsConnect,
  type ConnectedSocket,
} from './net.ts';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

interface ProbeTarget {
  ip: string;
  port: number;
  sni: string;
}

function mapError(err: unknown, elapsedMs: number): ProbeAttempt {
  const code = (err as NodeJS.ErrnoException)?.code;
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof AbortedError) return { ok: false, latencyMs: elapsedMs, error: 'aborted', errorMessage: 'aborted' };
  // OpenSSL failures often arrive with no `code` at all — the text is the only clue. An edge
  // that answers a ClientHello with `ssl/tls alert handshake failure` (a wrong or missing SNI,
  // a TLS version the edge refuses) used to be filed as `other`, which told the user nothing:
  // a real sweep of 60 edges reported `other: 81` for what was entirely an SNI problem.
  const sslText = /ssl|tls alert|handshake (failure|failed)|alert handshake/i.test(message);
  const kind: ProbeErrorKind =
    err instanceof TimeoutError
      ? 'timeout'
      : code === 'ECONNREFUSED'
        ? 'refused'
        : code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
          ? 'reset'
          : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
            ? 'dns'
            : code?.startsWith('ERR_TLS') || code?.startsWith('ERR_SSL') || sslText
              ? 'tls'
              : code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
                ? 'tls'
                : 'other';
  return { ok: false, latencyMs: elapsedMs, error: kind, errorMessage: message };
}

interface HttpRoundTrip {
  ok: boolean;
  status: number;
  ttfbMs: number;
  colo: string;
  server: string;
  error?: string;
}

async function httpRoundTrip(
  socket: net.Socket,
  cfg: ScanConfig,
  target: ProbeTarget,
  signal: AbortSignal,
): Promise<HttpRoundTrip> {
  const hostHeader = target.sni || target.ip;
  const request =
    `GET ${cfg.httpPath || '/'} HTTP/1.1\r\n` +
    `Host: ${hostHeader}\r\n` +
    `User-Agent: ${BROWSER_UA}\r\n` +
    `Accept: */*\r\n` +
    `Accept-Language: en-US,en;q=0.9\r\n` +
    `Accept-Encoding: identity\r\n` +
    `Connection: keep-alive\r\n\r\n`;
  socket.write(request);
  const read = await readUntil(socket, (d) => d.includes('\r\n\r\n'), Math.min(cfg.timeoutMs, 10_000), signal);
  const text = read.data.toString('latin1');
  const statusLine = text.split('\r\n')[0] ?? '';
  const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
  const colo = /cf-ray:\s*\S*-([A-Z]{3})/i.exec(text)?.[1] ?? '';
  const server = /^server:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
  if (!match) {
    return {
      ok: false,
      status: 0,
      ttfbMs: read.ms,
      colo,
      server,
      error: read.ended ? 'connection closed before any HTTP response' : 'no HTTP response within timeout',
    };
  }
  return { ok: true, status: Number(match[1]), ttfbMs: read.ms, colo, server };
}

async function wsUpgrade(
  target: ProbeTarget,
  cfg: ScanConfig,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let conn: ConnectedSocket | null = null;
  try {
    conn = await tlsConnect(target.ip, target.port, {
      timeoutMs: cfg.timeoutMs,
      signal,
      sni: target.sni,
      alpn: ['http/1.1'],
    });
    const hostHeader = target.sni || target.ip;
    const key = randomBytes(16).toString('base64');
    const request =
      `GET ${cfg.wsPath || '/'} HTTP/1.1\r\n` +
      `Host: ${hostHeader}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Origin: https://${hostHeader}\r\n` +
      `User-Agent: ${BROWSER_UA}\r\n\r\n`;
    conn.socket.write(request);
    const read = await readUntil(conn.socket, (d) => d.includes('\r\n\r\n'), cfg.timeoutMs, signal);
    const statusLine = read.data.toString('latin1').split('\r\n')[0] ?? '';
    const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
    if (!match) return { ok: false, status: 0, error: 'no upgrade response' };
    const status = Number(match[1]);
    return { ok: status === 101, status, error: status === 101 ? undefined : `upgrade answered ${status}` };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  } finally {
    destroy(conn?.socket);
  }
}

/** Runs a single attempt against one address. */
export async function probeOnce(
  target: ProbeTarget,
  cfg: ScanConfig,
  signal: AbortSignal,
  sniOverride?: string,
): Promise<ProbeAttempt> {
  const effective: ProbeTarget = { ...target, sni: sniOverride ?? target.sni };
  const started = Date.now();
  let conn: ConnectedSocket | null = null;
  try {
    if (cfg.mode === 'tcp') {
      conn = await tcpConnect(effective.ip, effective.port, { timeoutMs: cfg.timeoutMs, signal });
      return { ok: true, latencyMs: conn.latencyMs };
    }

    conn = await tlsConnect(effective.ip, effective.port, {
      timeoutMs: cfg.timeoutMs,
      signal,
      sni: effective.sni,
      alpn: ['http/1.1'],
    });
    const attempt: ProbeAttempt = { ok: true, latencyMs: conn.latencyMs };

    if (cfg.requireHttp || cfg.mode === 'http') {
      const http = await httpRoundTrip(conn.socket, cfg, effective, signal);
      attempt.latencyMs = http.ttfbMs;
      attempt.httpStatus = http.status;
      attempt.colo = http.colo;
      attempt.serverHeader = http.server;
      if (!http.ok) {
        attempt.ok = false;
        attempt.error = 'http';
        attempt.errorMessage = http.error;
        return attempt;
      }
    }

    if (cfg.requireWs) {
      const ws = await wsUpgrade(effective, cfg, signal);
      attempt.wsOk = ws.ok;
      if (!ws.ok) {
        attempt.ok = false;
        attempt.error = 'ws';
        attempt.errorMessage = ws.error;
        return attempt;
      }
    }

    if (cfg.stabilityMs > 0) {
      const hold = await holdIdle(conn.socket, cfg.stabilityMs, signal);
      attempt.stable = hold.stable;
      attempt.idleMs = hold.idleMs;
      if (!hold.stable) {
        attempt.ok = false;
        attempt.error = 'unstable';
        attempt.errorMessage = hold.error;
        return attempt;
      }
    }

    return attempt;
  } catch (err) {
    return mapError(err, Date.now() - started);
  } finally {
    destroy(conn?.socket);
  }
}

/* ---------------------------------- throughput -------------------------------- */

export interface SpeedResult {
  /**
   * What the transfer was worth believing. The ranking reads *this* — `mbps` only counts when it
   * says `measured` (`types.ts` documents the values, and why a cut always reads fast).
   */
  trust: SpeedTrust;
  /** The same thing as a boolean, for callers that only ask "is there a number?": `trust === 'measured'`. */
  ok: boolean;
  mbps: number;
  bytes: number;
  /** How many bytes the transfer asked for, so a short one can be read as a fraction of it. */
  targetBytes: number;
  ms: number;
  ttfbMs: number;
  /** How long the stream had been silent when reading stopped (`timeout` endings only). */
  idleMs?: number;
  /** What went wrong, in the words of the socket where there was one. */
  error?: string;
}

/**
 * The one place `ok` and `trust` are derived from each other.
 *
 * They are two views of one fact, and they were independent fields once: `drainBytes` reported
 * *how* reading stopped while `ok` was written by hand at each return site, so a transfer the path
 * had reset arrived as a confident number. Deriving one from the other makes that unrepresentable.
 */
function speedOutcome(trust: SpeedTrust, fields: Omit<SpeedResult, 'trust' | 'ok'>): SpeedResult {
  return { ...fields, trust, ok: trust === 'measured' };
}

/**
 * How long a transfer has to be silent before it counts as stuck rather than slow. A pipe
 * that is merely narrow keeps delivering, so a gap this long means the path stopped
 * forwarding the response, not that the line is congested.
 */
const STALL_IDLE_MS = 1500;

/**
 * The throughput endpoints live on their own host, and a Cloudflare edge only
 * routes that host when the SNI matches it. So the speed phase uses the URL's
 * own hostname as SNI unless the user pinned `speedSni`.
 */
function speedSni(target: ProbeTarget, url: URL, cfg: ScanConfig): string {
  if (cfg.speedSni) return cfg.speedSni;
  return url.hostname;
}

/**
 * The HTTP status of a response, or `null` when nothing HTTP-shaped arrived.
 *
 * The speed phases have to read it: an error page is only a few kilobytes, so counting
 * whatever bytes arrive as a download reports a *green* transfer of nonsense (measured on
 * a real line: `403 error code: 1034` from a Cloudflare edge the speed host is not served
 * on — 8271 bytes read as "0.69 Mbps" and marked ok). That number then ranks every address
 * in the speed phase, which is the phase the whole scan exists for.
 */
function statusOf(head: Buffer): number | null {
  const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head.toString('latin1'));
  return match ? Number(match[1]) : null;
}

/**
 * The speed URL for this transfer.
 *
 * It does not fall back to Cloudflare's own endpoint any more: that catch turned a typo in
 * `--speed-url` into a silent scan against a host the user never named — the requests went out
 * with `speed.cloudflare.com` as their SNI (that is the SNI `speedSni` derives from the *URL*), the
 * transfers succeeded, and the rows were ranked by a measurement of an endpoint the run was not
 * configured to use. `sanitizeConfig` refuses a value that is not a full http(s) URL, so a throw
 * here is a value that reached the probe by some other road (an old saved session, a test), and it
 * is reported as a request that could not be formed — not as a path verdict.
 */
function resolveSpeedUrl(template: string, bytes: number): URL {
  return new URL(template.replace('%BYTES%', String(bytes)));
}

/**
 * Whether a failure says "the endpoint would not take this request" rather than "the path broke" —
 * which is the difference between the row being this address's verdict and it being the endpoint's.
 *
 * The doc for `SpeedTrust.rejected` already covers this shape: the request and the endpoint did not
 * match, which happens to every address on the line the same way and says nothing about throughput.
 * A TLS alert (`ssl/tls alert handshake failure`, `wrong version number` — an edge that does not
 * serve this SNI, hosted behind a port that is not TLS at all) is exactly that, and it used to
 * arrive as `cut`: the row was penalised as a DPI/NAT signature and `ezscan doctor` advised the
 * user to lower `--speed-bytes` on a line that was merely pointed at the wrong host.
 *
 * Deliberately *not* here: a reset (`ECONNRESET`, `socket hang up`, `EPIPE`), a refusal of the SYN
 * (`ECONNREFUSED`) or a silent deadline. Those are things the path did to a connection — and on an
 * address that answered a probe on this very port a moment ago, a RST is the DPI signature the
 * whole tool is looking for, so they keep their `cut`.
 */
function refusedByEndpoint(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code ?? '';
  const message = (err as Error)?.message ?? '';
  return (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    /ssl|tls alert|handshake failure|handshake failed|alert handshake|wrong version number|unable to verify|self-signed|no peer certificate/i.test(
      message,
    )
  );
}

/**
 * Direct-path download measurement (no proxy). It ranks addresses against each
 * other; absolute numbers differ from what a tunnel will deliver.
 */
export async function measureDownload(
  target: ProbeTarget,
  cfg: ScanConfig,
  signal: AbortSignal,
): Promise<SpeedResult> {
  let conn: ConnectedSocket | null = null;
  const started = Date.now();
  try {
    // Resolved inside the try so a URL that cannot be formed is reported as one, instead of
    // escaping as a rejected promise out of the speed phase.
    const url = resolveSpeedUrl(cfg.speedUrl, cfg.speedBytes);
    const sni = speedSni(target, url, cfg);
    conn = await tlsConnect(target.ip, target.port, {
      timeoutMs: cfg.timeoutMs,
      signal,
      sni,
      alpn: ['http/1.1'],
    });
    const hostHeader = url.host;
    const request =
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      `User-Agent: ${BROWSER_UA}\r\n` +
      `Accept: */*\r\n` +
      `Accept-Encoding: identity\r\n` +
      `Connection: close\r\n\r\n`;
    conn.socket.write(request);
    const drained = await drainBytes(conn.socket, cfg.speedBytes, cfg.speedTimeoutMs, signal);
    const base = {
      mbps: 0,
      bytes: drained.bytes,
      targetBytes: cfg.speedBytes,
      ms: Math.round(drained.ms),
      ttfbMs: Math.round(drained.firstByteMs),
      ...(drained.endedBy === 'timeout' ? { idleMs: Math.round(drained.idleMs) } : {}),
    };
    // A transfer that ran out of deadline while the stream had gone silent is not a slow line, it
    // is a stuck one — the signature a PPPoE line with a broken PMTUD leaves when the response is
    // bigger than the path MTU. Counting it as throughput reports a real number for an imaginary
    // transfer, which is worse than failing: on fiber this number then decides the ranking of the
    // whole speed phase. It is checked before the byte count so a stream that went quiet without
    // ever sending anything is read as a stall — which is what it is — and not as "no data".
    if (drained.endedBy === 'timeout' && drained.idleMs >= STALL_IDLE_MS) {
      return speedOutcome('stalled', {
        ...base,
        error: `the transfer stalled after ${drained.bytes} bytes (no data for ${Math.round(drained.idleMs / 100) / 10}s)`,
      });
    }
    // The scan was stopped; that is a fact about us, not about this path, so it leaves no verdict
    // on the row — a `cut` here would blame the address for the user pressing Ctrl-C.
    if (drained.endedBy === 'abort') return speedOutcome('untested', { ...base, error: 'aborted' });
    // A socket error and a stall are the same claim about the line — "this transfer did not
    // happen" — and they were told apart only for the quiet one. `drainBytes` reported "read
    // stopped before the deadline", which is a *cut* stream and a *slow* stream at once, so a
    // transfer the path reset after 64 KB of a requested 8 MB was ranked by the throughput those
    // 64 KB happened to reach: a number for an imaginary transfer, in the phase the whole scan
    // exists for. The bytes are kept for the message, the number is not.
    if (drained.endedBy === 'error') {
      return speedOutcome('cut', {
        ...base,
        error: `the transfer was cut after ${drained.bytes} bytes (${drained.error ?? 'connection error'})`,
      });
    }
    if (drained.bytes <= 0) return speedOutcome('rejected', { ...base, error: 'no data' });
    // Only a 2xx is a transfer. Anything else is an error page (or a redirect body) whose
    // size says nothing about the line, and reporting it as throughput would rank the
    // addresses by it.
    const status = statusOf(drained.head);
    if (status === null) return speedOutcome('rejected', { ...base, error: 'no HTTP status line' });
    if (status < 200 || status >= 300) return speedOutcome('rejected', { ...base, error: `HTTP ${status}` });
    // The endpoint ended the stream before the payload arrived — the shape a rate limit, a proxy
    // with a byte cap, or a DPI box that is being *polite* leaves. The bytes it did send are real
    // bytes that really crossed the line, and that is exactly what makes them untrustworthy: they
    // are the first congestion window, where the transfer is at its fastest, so a short transfer
    // always reads *fast*. A gateway that caps a response at 64 KB of 8 MB therefore used to
    // produce the best-looking number in the scan. The count is reported as a fraction so the
    // reader can see a cap for what it is; the number never ranks anything.
    if (drained.endedBy === 'close') {
      const pct = Math.round((drained.bytes / Math.max(1, cfg.speedBytes)) * 100);
      return speedOutcome('partial', {
        ...base,
        error: `the endpoint ended the stream after ${drained.bytes} bytes of ${cfg.speedBytes} requested (${pct}%)`,
      });
    }
    // Throughput is measured from the first byte so the handshake/queueing
    // latency does not pollute the number. A deadline *we* set while data was still flowing ends
    // here too: nothing about the path is in doubt, the window was simply ours.
    const window = drained.ms - drained.firstByteMs;
    const seconds = (window > 50 ? window : drained.ms) / 1000;
    const mbps = (drained.bytes * 8) / seconds / 1e6;
    return speedOutcome('measured', { ...base, mbps: Math.round(mbps * 100) / 100 });
  } catch (err) {
    // A dial that never completed says nothing about throughput — and an aborted one says nothing
    // about anything, so it is not this path's verdict to carry.
    const aborted = signal.aborted || err instanceof AbortedError;
    const badUrl = /invalid url/i.test((err as Error)?.message ?? '');
    const trust: SpeedTrust = aborted ? 'untested' : badUrl || refusedByEndpoint(err) ? 'rejected' : 'cut';
    return speedOutcome(trust, {
      mbps: 0,
      bytes: 0,
      targetBytes: cfg.speedBytes,
      ms: Date.now() - started,
      ttfbMs: 0,
      error: aborted ? 'aborted' : badUrl ? `the speed URL is not a URL (${(err as Error).message})` : (err as Error).message,
    });
  } finally {
    destroy(conn?.socket);
  }
}

export async function measureUpload(
  target: ProbeTarget,
  cfg: ScanConfig,
  signal: AbortSignal,
): Promise<SpeedResult> {
  let conn: ConnectedSocket | null = null;
  const started = Date.now();
  const bytes = Math.max(64 * 1024, cfg.uploadBytes);
  try {
    const url = new URL(cfg.uploadUrl);
    conn = await tlsConnect(target.ip, target.port, {
      timeoutMs: cfg.timeoutMs,
      signal,
      sni: speedSni(target, url, cfg),
      alpn: ['http/1.1'],
    });
    const hostHeader = url.host;
    const request =
      `POST ${url.pathname}${url.search} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      `User-Agent: ${BROWSER_UA}\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${bytes}\r\n` +
      `Connection: close\r\n\r\n`;
    conn.socket.write(request);
    const payload = Buffer.alloc(bytes, 0x61);
    const writeStart = Date.now();
    conn.socket.write(payload);
    const read = await readUntil(conn.socket, (d) => d.includes('\r\n\r\n'), cfg.speedTimeoutMs, signal);
    const elapsed = Date.now() - writeStart;
    const base = { mbps: 0, bytes, targetBytes: bytes, ms: elapsed, ttfbMs: 0 };
    // Same rule as the download: the payload only counts if the endpoint accepted it. The payload
    // itself always leaves the socket (it is written before the answer is read), so the verdict
    // here is entirely about what came back.
    const status = statusOf(read.data);
    if (status === null) {
      return read.ended
        ? speedOutcome('rejected', { ...base, error: 'the endpoint closed without answering the upload' })
        : speedOutcome('stalled', { ...base, error: `no response to the upload within ${cfg.speedTimeoutMs}ms` });
    }
    if (status < 200 || status >= 300) return speedOutcome('rejected', { ...base, error: `HTTP ${status}` });
    const mbps = (bytes * 8) / Math.max(elapsed, 1) / 1000;
    return speedOutcome('measured', { ...base, mbps: Math.round(mbps * 100) / 100 });
  } catch (err) {
    const aborted = signal.aborted || err instanceof AbortedError;
    const badUrl = /invalid url/i.test((err as Error)?.message ?? '');
    const trust: SpeedTrust = aborted ? 'untested' : badUrl || refusedByEndpoint(err) ? 'rejected' : 'cut';
    return speedOutcome(trust, {
      mbps: 0,
      bytes,
      targetBytes: bytes,
      ms: Date.now() - started,
      ttfbMs: 0,
      error: aborted ? 'aborted' : badUrl ? `the upload URL is not a URL (${(err as Error).message})` : (err as Error).message,
    });
  } finally {
    destroy(conn?.socket);
  }
}
