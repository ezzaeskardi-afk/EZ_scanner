/**
 * Low-level socket helpers.
 *
 * Everything here is deliberately dependency-free: raw `net`/`tls` sockets give
 * us the exact timing we need (connect, handshake, first byte, idle survival)
 * which a higher level HTTP client would hide.
 */
import net from 'node:net';
import tls from 'node:tls';

interface ConnectOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  localAddress?: string;
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

export class TimeoutError extends Error {
  constructor(message = 'timeout') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface ConnectedSocket {
  socket: net.Socket | tls.TLSSocket;
  /** ms until TCP connect (tcp mode) or TLS handshake completion (tls mode). */
  latencyMs: number;
  tcpMs: number;
}

function attachAbort(socket: net.Socket, signal: AbortSignal | undefined, fail: (err: Error) => void): () => void {
  if (!signal) return () => {};
  const onAbort = () => {
    socket.destroy();
    fail(new AbortedError());
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export function tcpConnect(host: string, port: number, opts: ConnectOptions): Promise<ConnectedSocket> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = net.connect({ host, port, ...(opts.localAddress ? { localAddress: opts.localAddress } : {}) });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new TimeoutError(`tcp connect timeout ${host}:${port}`)), opts.timeoutMs);
    const detach = attachAbort(socket, opts.signal, fail);
    socket.setNoDelay(true);
    socket.on('error', (err) => fail(err));
    socket.on('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ socket, latencyMs: ms, tcpMs: ms });
    });
  });
}

interface TlsConnectOptions extends ConnectOptions {
  sni?: string;
  alpn?: string[];
  /** Skip certificate verification (default true — we are measuring reachability). */
  insecure?: boolean;
}

export function tlsConnect(
  host: string,
  port: number,
  opts: TlsConnectOptions,
): Promise<ConnectedSocket> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = tls.connect({
      host,
      port,
      servername: opts.sni && !isIpLiteral(opts.sni) ? opts.sni : undefined,
      ALPNProtocols: opts.alpn ?? ['http/1.1'],
      rejectUnauthorized: opts.insecure === false,
      // Some middleboxes only answer when the ClientHello looks like a browser.
      minVersion: 'TLSv1.2',
    });
    socket.setKeepAlive(true, 15_000);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new TimeoutError(`tls handshake timeout ${host}:${port}`)),
      opts.timeoutMs,
    );
    const detach = attachAbort(socket, opts.signal, fail);
    socket.setNoDelay(true);
    socket.on('error', (err) => fail(err));
    socket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ socket, latencyMs: ms, tcpMs: ms });
    });
  });
}

function isIpLiteral(host: string): boolean {
  if (net.isIP(host)) return true;
  return /^\[.*\]$/.test(host);
}

interface ReadResult {
  data: Buffer;
  ms: number;
  ended: boolean;
}

/**
 * Reads until `matcher(data)` is true, the socket ends, or the deadline passes.
 * Returns whatever arrived so the caller can report partial responses.
 */
export function readUntil(
  socket: net.Socket,
  matcher: (data: Buffer) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ReadResult> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (ended: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve({ data: Buffer.concat(chunks), ms: Number(process.hrtime.bigint() - started) / 1e6, ended });
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      if (matcher(Buffer.concat(chunks))) finish(false);
    };
    const onError = (err: Error) => finish(true, err);
    const onClose = () => finish(true);
    const onAbort = () => finish(true, new AbortedError());
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

interface DrainResult {
  bytes: number;
  ms: number;
  firstByteMs: number;
  ended: boolean;
  /**
   * How long the stream had been silent when reading stopped. This is the difference between
   * "this line is slow" and "this transfer stopped moving": a narrow pipe keeps trickling, a
   * PMTU/MTU hole goes quiet after the first window and never comes back.
   */
  idleMs: number;
  /** The first `HEAD_BYTES` of the stream, so the caller can read the status line. */
  head: Buffer;
}

/** How much of the start of a stream is kept for inspection (a status line and headers). */
const HEAD_BYTES = 1024;

/**
 * Counts bytes until `target` is reached, the socket ends, or the deadline passes. The result
 * says which of those happened (`ended`), and how quiet the stream had gone (`idleMs`).
 */
export function drainBytes(
  socket: net.Socket,
  target: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DrainResult> {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let bytes = 0;
    let firstByteMs = 0;
    let settled = false;
    const head: Buffer[] = [];
    let headBytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onDone);
      socket.off('close', onDone);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    let lastDataMs = 0;
    // `ended` used to be hardcoded true, which made the deadline indistinguishable from a
    // finished transfer; it now means "the stream finished on its own" (the target arrived, or
    // the peer closed) rather than "we stopped reading".
    const onDone = (ended: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({
        bytes,
        ms,
        firstByteMs,
        ended,
        idleMs: lastDataMs ? Math.max(0, ms - lastDataMs) : ms,
        head: Buffer.concat(head),
      });
    };
    const onData = (chunk: Buffer) => {
      lastDataMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (!firstByteMs) firstByteMs = lastDataMs;
      bytes += chunk.length;
      if (headBytes < HEAD_BYTES) {
        const slice = chunk.subarray(0, HEAD_BYTES - headBytes);
        head.push(slice);
        headBytes += slice.length;
      }
      if (bytes >= target) onDone(true);
    };
    const onAbort = () => onDone(false);
    const timer = setTimeout(() => onDone(false), timeoutMs);
    socket.on('data', onData);
    socket.on('error', () => onDone(false));
    socket.on('close', () => onDone(true));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolves `true` when the socket is still healthy after `ms` of silence.
 * A DPI box that kills idle TLS sessions shows up here as close/reset.
 */
export function holdIdle(
  socket: net.Socket,
  ms: number,
  signal?: AbortSignal,
): Promise<{ stable: boolean; idleMs: number; error?: string }> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve({ stable: true, idleMs: 0 });
      return;
    }
    const started = Date.now();
    let settled = false;
    const done = (stable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('close', onClose);
      socket.off('error', onError);
      socket.off('end', onClose);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ stable, idleMs: Date.now() - started, error });
    };
    const onClose = () => done(false, 'connection closed while idle');
    const onError = (err: Error) => done(false, err.message);
    const onAbort = () => done(false, 'aborted');
    const timer = setTimeout(() => done(true), ms);
    socket.on('close', onClose);
    socket.on('error', onError);
    socket.on('end', onClose);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function destroy(socket: net.Socket | null | undefined): void {
  if (!socket) return;
  try {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    socket.destroy();
  } catch {
    /* already gone */
  }
}
