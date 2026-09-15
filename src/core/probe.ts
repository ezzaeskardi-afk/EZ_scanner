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
import type { ProbeAttempt, ProbeErrorKind, ScanConfig } from './types.ts';
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

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export interface ProbeTarget {
  ip: string;
  port: number;
  sni: string;
}

export function mapError(err: unknown, elapsedMs: number): ProbeAttempt {
  const code = (err as NodeJS.ErrnoException)?.code;
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof AbortedError) return { ok: false, latencyMs: elapsedMs, error: 'aborted', errorMessage: 'aborted' };
  const kind: ProbeErrorKind =
    err instanceof TimeoutError
      ? 'timeout'
      : code === 'ECONNREFUSED'
        ? 'refused'
        : code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
          ? 'reset'
          : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
            ? 'dns'
            : code?.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
              ? 'tls'
              : code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
                ? 'other'
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
  ok: boolean;
  mbps: number;
  bytes: number;
  ms: number;
  ttfbMs: number;
  error?: string;
}

/**
 * The throughput endpoints live on their own host, and a Cloudflare edge only
 * routes that host when the SNI matches it. So the speed phase uses the URL's
 * own hostname as SNI unless the user pinned `speedSni`.
 */
function speedSni(target: ProbeTarget, url: URL, cfg: ScanConfig): string {
  if (cfg.speedSni) return cfg.speedSni;
  return url.hostname;
}

function resolveSpeedUrl(template: string, bytes: number): URL {
  const filled = template.replace('%BYTES%', String(bytes));
  try {
    return new URL(filled);
  } catch {
    return new URL(`https://speed.cloudflare.com/__down?bytes=${bytes}`);
  }
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
  const url = resolveSpeedUrl(cfg.speedUrl, cfg.speedBytes);
  const sni = speedSni(target, url, cfg);
  let conn: ConnectedSocket | null = null;
  const started = Date.now();
  try {
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
    if (drained.bytes <= 0) {
      return { ok: false, mbps: 0, bytes: 0, ms: drained.ms, ttfbMs: drained.firstByteMs, error: 'no data' };
    }
    // Throughput is measured from the first byte so the handshake/queueing
    // latency does not pollute the number.
    const window = drained.ms - drained.firstByteMs;
    const seconds = (window > 50 ? window : drained.ms) / 1000;
    const mbps = (drained.bytes * 8) / seconds / 1e6;
    return {
      ok: true,
      mbps: Math.round(mbps * 100) / 100,
      bytes: drained.bytes,
      ms: Math.round(drained.ms),
      ttfbMs: Math.round(drained.firstByteMs),
    };
  } catch (err) {
    return {
      ok: false,
      mbps: 0,
      bytes: 0,
      ms: Date.now() - started,
      ttfbMs: 0,
      error: (err as Error).message,
    };
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
    const responded = /^HTTP\/1\.[01]\s+\d{3}/.test(read.data.toString('latin1'));
    if (!responded) {
      return { ok: false, mbps: 0, bytes, ms: elapsed, ttfbMs: 0, error: 'no response to upload' };
    }
    const mbps = (bytes * 8) / Math.max(elapsed, 1) / 1000;
    return {
      ok: true,
      mbps: Math.round(mbps * 100) / 100,
      bytes,
      ms: elapsed,
      ttfbMs: 0,
    };
  } catch (err) {
    return {
      ok: false,
      mbps: 0,
      bytes,
      ms: Date.now() - started,
      ttfbMs: 0,
      error: (err as Error).message,
    };
  } finally {
    destroy(conn?.socket);
  }
}
