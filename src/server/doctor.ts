/**
 * `ezscan doctor` / GUI diagnostics.
 *
 * Purpose: answer the single most common support question ("the scanner finds
 * nothing — is it the tool or my line?") without asking the user to read logs.
 */
import { access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG } from '../core/types.ts';
import { defaultResolve } from '../core/ipsrc.ts';
import { measureDownload, probeOnce } from '../core/probe.ts';
import { readUntil, tcpConnect, tlsConnect, type ConnectedSocket } from '../core/net.ts';
import type { ProbeAttempt } from '../core/types.ts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
  summary: string;
  /** Set when the system resolver answered a public name with a known block-page address. */
  dnsHijack?: DnsHijack;
  /** What the line does to a burst, to TLS, and to a large transfer. */
  signature?: LineSignature;
  /** The preset matching the signature, when the line showed one. */
  recommendation?: LineRecommendation;
}

/**
 * What an access network *does*, measured rather than asked about.
 *
 * Each field is a mechanism the per-operator presets exist to survive, and each is observable
 * from userspace without root: a burst of sessions finds the table and the new-session cap, a
 * TLS handshake repeated a few times finds DPI resets, and a large transfer finds the MTU hole.
 * `transfer` is filled by the caller from the throughput row that already ran, so the signature
 * costs no extra transfer.
 */
export interface LineSignature {
  /** The address the burst dialled. */
  ip: string;
  /** Sessions opened at once, and what each one did at the TCP level. */
  burst: { opened: number; connected: number; refused: number; timedOut: number };
  /**
   * Full probes attempted *while that burst was still open* — the same ones a scan runs, which is
   * the only way to see a saturated table: such a session accepts the TCP connection and even
   * completes the TLS handshake, then never reads the request. At the TCP level it looks
   * perfectly connected.
   */
  underLoad: { attempts: number; ok: number; reset: number; timedOut: number; other: number };
  /**
   * One connection made right after everything was closed. A table that had filled answers
   * again; a cap on new sessions per second does not care, which is how the two are told apart.
   */
  followUp: 'ok' | 'refused' | 'timeout' | 'other';
  /** Median connect time over the sessions that connected, 0 when none did. */
  medianConnectMs: number;
  /**
   * The same probes on an idle line — the control for `underLoad`. If these fail too, the line
   * itself is being interfered with and concurrency is not the cause.
   */
  idle: { attempts: number; ok: number; reset: number; timedOut: number; other: number };
  /** How a large transfer behaved, when the throughput row managed to run one. */
  transfer?: { bytes: number; targetBytes: number; stale: boolean; idleMs: number; error?: string };
}

/** The preset to run, and the evidence that named it. Reachable through `DoctorReport`. */
interface LineRecommendation {
  /** `--preset <name>`, or null when the line showed no operator-specific signature. */
  preset: string | null;
  /** One sentence per mechanism that matched, strongest first. */
  reasons: string[];
}

/** The system resolver answered a public name with an address that cannot be the real one. */
interface DnsHijack {
  name: string;
  answer: string[];
  reason: string;
  /** What DNS-over-HTTPS said the real answer is, when it was reachable. */
  viaDoh: string[];
  dohVia: string | null;
}

const CF_PROBE_IP = '104.16.132.229';

/** Names the resolver is asked for — both are Cloudflare hosts the scanner itself uses. */
const DNS_PROBES = ['cloudflare.com', 'speed.cloudflare.com'];

/**
 * Addresses the Iranian DPI answers with instead of the real one: the block page and its
 * siblings. Nothing legitimate ever resolves a public name into this gap.
 */
const BLOCK_PAGE_IPS = new Set(['10.10.34.34', '10.10.34.35', '10.10.34.36']);

/**
 * Why a resolver answer cannot be genuine, or `null` when it looks legitimate.
 *
 * Exported so the check can be pinned by tests: a poisoned line is the one failure mode
 * that makes a healthy scanner look broken, because every domain source then probes an
 * address that was never the host's.
 */
export function hijackReason(ip: string): string | null {
  const addr = (ip ?? '').replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(addr);
  if (family === 0) return `not an IP address (${ip})`;
  if (family === 4) {
    if (BLOCK_PAGE_IPS.has(addr)) return 'the operator block-page address';
    const [a, b] = addr.split('.').map(Number);
    const privateV4 =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT space
    return privateV4 ? 'a private/unroutable address' : null;
  }
  if (addr === '::' || addr === '::1') return 'a private/unroutable address';
  if (/^f[cd]/i.test(addr)) return 'a private/unroutable address';
  return null;
}

/**
 * DoH providers, pinned by IP with their own SNI. Connecting by address is the point: the
 * system resolver is the thing under test, so the check must not need it to work.
 */
const DOH_PROVIDERS = [
  { ip: '1.1.1.1', sni: 'cloudflare-dns.com', path: '/dns-query', label: '1.1.1.1' },
  { ip: '8.8.8.8', sni: 'dns.google', path: '/resolve', label: '8.8.8.8' },
];

/** Pulls the A records out of a DoH JSON response (`Answer[].data`, type 1). */
export function parseDohAnswers(body: string): string[] {
  try {
    const parsed = JSON.parse(body.slice(body.indexOf('{'))) as {
      Answer?: Array<{ type?: number; data?: string }>;
    };
    return (parsed.Answer ?? [])
      .filter((record) => record.type === 1 && typeof record.data === 'string')
      .map((record) => record.data!.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Waits for the whole response body, so a Content-Length answer is never read early. */
function bodyComplete(data: Buffer): boolean {
  const text = data.toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  if (split < 0) return false;
  const head = text.slice(0, split);
  const body = data.length - (split + 4);
  const length = /content-length:\s*(\d+)/i.exec(head);
  if (length) return body >= Number(length[1]);
  if (/transfer-encoding:\s*chunked/i.test(head)) return text.endsWith('0\r\n\r\n');
  return false;
}

/**
 * One A lookup over DoH. Returns `null` when neither provider could be reached — which on
 * a filtered line is itself normal and must not be reported as a failure.
 */
async function resolveOverHttps(
  name: string,
  signal: AbortSignal,
): Promise<{ ips: string[]; via: string } | null> {
  const deadline = Date.now() + 6000;
  for (const provider of DOH_PROVIDERS) {
    const budget = Math.min(3500, deadline - Date.now());
    if (budget <= 0) break;
    let conn: ConnectedSocket | null = null;
    try {
      conn = await tlsConnect(provider.ip, 443, {
        timeoutMs: budget,
        signal,
        sni: provider.sni,
        alpn: ['http/1.1'],
      });
      conn.socket.write(
        `GET ${provider.path}?name=${encodeURIComponent(name)}&type=A HTTP/1.1\r\n` +
          `Host: ${provider.sni}\r\n` +
          'Accept: application/dns-json\r\n' +
          'Connection: close\r\n\r\n',
      );
      const read = await readUntil(conn.socket, bodyComplete, budget, signal);
      const body = read.data.toString('utf8');
      const ips = parseDohAnswers(body.slice(body.indexOf('\r\n\r\n') + 4));
      if (ips.length) return { ips, via: provider.label };
    } catch {
      /* try the next provider */
    } finally {
      conn?.socket.destroy();
    }
  }
  return null;
}

/** Sessions opened at once when measuring the burst. Small enough to be harmless on a good
 * line, large enough that a per-subscriber CGNAT slot or a cheap ONU table notices. */
const BURST_SESSIONS = 12;

/**
 * Probes run while the burst is held, and again on the idle line as a control. A handful is
 * enough for a signature; these are real requests to a real edge, so the number stays small.
 */
const PROBE_ATTEMPTS = 6;

function errorKind(err: unknown, timeoutMs: number): 'refused' | 'timeout' | 'reset' | 'other' {
  const message = (err as Error)?.message ?? String(err);
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(message)) return 'refused';
  if (code === 'ECONNRESET' || /ECONNRESET|socket hang up|EPIPE/.test(message)) return 'reset';
  if (code === 'ETIMEDOUT' || /timeout/i.test(message) || timeoutMs <= 0) return 'timeout';
  return 'other';
}

/**
 * Measures the line's signature against one reachable edge.
 *
 * Exported (and injectable) so it can be pinned against the harness instead of the internet:
 * the whole point of the per-operator presets is that these mechanisms are real, so the
 * measurement that names a preset has to be testable the same way the presets are.
 */
export async function measureLineSignature(
  target: { ip: string; port: number; sni: string },
  signal: AbortSignal,
  opts: {
    burst?: number;
    /** Probes attempted under load, and (as a control) on the idle line. */
    probeAttempts?: number;
    connectTimeoutMs?: number;
    probeTimeoutMs?: number;
    /** Upper bound on the whole measurement; later steps are skipped once it is spent. */
    budgetMs?: number;
  } = {},
): Promise<LineSignature> {
  const burstSize = opts.burst ?? BURST_SESSIONS;
  const probeAttempts = opts.probeAttempts ?? PROBE_ATTEMPTS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 2500;

  const budgetMs = opts.budgetMs ?? 12_000;
  const deadline = Date.now() + budgetMs;

  // The burst: every session starts together and is *held*. Holding them is the whole
  // measurement — a table is filled by concurrency, and a probe that hangs up the instant it
  // connects leaves the table empty. The ones that connect stay open while the others burn
  // their timeout, which is what a real burst does to a capped line.
  const opened = Array.from({ length: burstSize }, () =>
    tcpConnect(target.ip, target.port, { timeoutMs: connectTimeoutMs, signal }),
  );
  const settled = await Promise.allSettled(opened);
  const latencies: number[] = [];
  const held: ConnectedSocket[] = [];
  let refused = 0;
  let timedOut = 0;
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      latencies.push(outcome.value.latencyMs);
      held.push(outcome.value);
      continue;
    }
    const kind = errorKind(outcome.reason, connectTimeoutMs);
    if (kind === 'timeout') timedOut += 1;
    else refused += 1;
  }

  // With those sessions still open, run full probes on top of them — a real request that has to
  // come back. This is the row that sees a session table: a session accepted by a full table
  // completes its handshake and then never reads the request, so the probe times out while every
  // single connection on the same line is perfect. Run in parallel on purpose, since sequential
  // probes would never overlap the burst.
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2500;
  const probe = async (): Promise<ProbeAttempt> =>
    probeOnce(
      { ip: target.ip, port: target.port, sni: target.sni },
      { ...DEFAULT_CONFIG, mode: 'http', requireHttp: true, tries: 1, timeoutMs: probeTimeoutMs },
      signal,
    );
  const count = (bucket: LineSignature['idle'], attempt: ProbeAttempt): void => {
    bucket.attempts += 1;
    if (attempt.ok) bucket.ok += 1;
    else if (attempt.error === 'reset' || attempt.error === 'refused') bucket.reset += 1;
    else if (attempt.error === 'timeout') bucket.timedOut += 1;
    else bucket.other += 1;
  };

  const underLoad: LineSignature['underLoad'] = { attempts: 0, ok: 0, reset: 0, timedOut: 0, other: 0 };
  for (const attempt of await Promise.all(Array.from({ length: probeAttempts }, () => probe()))) {
    count(underLoad, attempt);
  }

  for (const conn of held) conn.socket.destroy();

  // The follow-up: with everything closed, a table that had filled has room again. A cap on new
  // sessions per second does not care, which is the difference between "lower the workers"
  // and "lower the rate".
  let followUp: LineSignature['followUp'] = 'other';
  try {
    const conn = await tcpConnect(target.ip, target.port, { timeoutMs: connectTimeoutMs, signal });
    conn.socket.destroy();
    followUp = 'ok';
  } catch (err) {
    const kind = errorKind(err, connectTimeoutMs);
    followUp = kind === 'reset' || kind === 'refused' ? 'refused' : kind;
  }

  // The control: the same probe on an idle line. Only if these fail as well is the line itself
  // being interfered with rather than merely capped. Stops early once the answer is clear, since
  // every unanswered probe costs its whole timeout.
  const idle: LineSignature['idle'] = { attempts: 0, ok: 0, reset: 0, timedOut: 0, other: 0 };
  for (let i = 0; i < probeAttempts; i++) {
    if (Date.now() > deadline) break;
    count(idle, await probe());
    if (idle.ok >= 2 || idle.reset >= 2) break;
  }

  latencies.sort((a, b) => a - b);
  const medianConnectMs = latencies.length ? Math.round(latencies[Math.floor(latencies.length / 2)]) : 0;
  return {
    ip: target.ip,
    burst: { opened: burstSize, connected: latencies.length, refused, timedOut },
    underLoad,
    followUp,
    medianConnectMs,
    idle,
  };
}

/**
 * Names the preset a measured signature calls for, with the evidence, or null when the line
 * shows no operator-specific behaviour (a clean line needs no special preset).
 *
 * The order is deliberate. A stalled large transfer is the fiber/PPPoE signature and it changes
 * the *speed* settings, which nothing else does, so it is checked first. A repeatable reset is
 * more specific than "sessions went missing" — a line that resets TLS mid-handshake needs the
 * gentler cadence whatever else it does. The CGNAT shape is the fallback: fewer sessions, at a
 * lower rate, with the timeouts a black-holed SYN needs to survive.
 */
export function classifyLine(signature: LineSignature): LineRecommendation {
  const reasons: string[] = [];
  const turnedAway = signature.burst.refused + signature.burst.timedOut;
  const blockedUnderLoad = signature.underLoad.timedOut + signature.underLoad.reset;
  const resetRate = signature.idle.attempts ? signature.idle.reset / signature.idle.attempts : 0;

  if (signature.transfer?.stale) {
    const t = signature.transfer;
    reasons.push(
      `a large transfer stalled after ${t.bytes} bytes with no data for ` +
        `${Math.round(t.idleMs / 100) / 10}s — the path drops packets bigger than its MTU (the PPPoE/PMTUD hole)`,
    );
    return { preset: 'mobin', reasons };
  }

  // A reset on an idle line is DPI. A reset only under load is the cap itself, so the two are
  // kept apart by which bucket the reset landed in.
  if (resetRate >= 0.25 && signature.idle.reset >= 2) {
    reasons.push(
      `${signature.idle.reset} of ${signature.idle.attempts} connections were reset even with nothing else ` +
        'open — something on the path is killing them, so the cadence has to stay gentle',
    );
    if (blockedUnderLoad > 0) {
      reasons.push(`and ${blockedUnderLoad} of ${signature.underLoad.attempts} connections under load never completed`);
    }
    return { preset: 'mci', reasons };
  }

  if (turnedAway > 0 || blockedUnderLoad > 0) {
    const detail =
      blockedUnderLoad > 0
        ? `${blockedUnderLoad} of ${signature.underLoad.attempts} probes attempted while ` +
          `${signature.burst.connected} other sessions were held open never completed ` +
          `(${signature.underLoad.timedOut} timed out, ${signature.underLoad.reset} reset with the socket open)`
        : `${turnedAway} of ${signature.burst.opened} sessions opened at the same time were turned away ` +
          `(${signature.burst.timedOut} black-holed, ${signature.burst.refused} refused)`;
    reasons.push(
      `${detail} — the line caps how many sessions you may hold at once` +
        (signature.followUp === 'ok'
          ? ', while a single connection right after works fine, so the cap is on concurrency and `--workers` is the lever'
          : ', and even a single connection right after was refused, so the cap is on new sessions per second and `--rate` is the lever'),
    );
    return { preset: 'irancell', reasons };
  }

  return { preset: null, reasons };
}

/** Renders the measured signature as the one-line detail of the report row. */
function describeSignature(sig: LineSignature): string {
  const burst =
    `${sig.burst.connected}/${sig.burst.opened} sessions at once` +
    (sig.medianConnectMs ? ` (median ${sig.medianConnectMs}ms)` : '') +
    (sig.burst.refused ? ` · ${sig.burst.refused} refused` : '') +
    (sig.burst.timedOut ? ` · ${sig.burst.timedOut} black-holed` : '');
  const underLoad = `probes under ${sig.burst.connected} open sessions: ` +
    `${sig.underLoad.ok}/${sig.underLoad.attempts} ok` +
    (sig.underLoad.timedOut ? ` · ${sig.underLoad.timedOut} timed out` : '') +
    (sig.underLoad.reset ? ` · ${sig.underLoad.reset} reset` : '');
  const idle = `probes on an idle line: ${sig.idle.ok}/${sig.idle.attempts} ok` +
    (sig.idle.reset ? ` · ${sig.idle.reset} reset` : '') +
    (sig.idle.timedOut ? ` · ${sig.idle.timedOut} timed out` : '');
  return `${burst} | ${underLoad} | ${idle} | a single retry ${sig.followUp === 'ok' ? 'connects' : sig.followUp}`;
}

export async function runDoctor(dataDir: string, sampleSni = 'www.cloudflare.com'): Promise<DoctorReport> {
  const checks: Check[] = [];
  const controller = new AbortController();

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1]);
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);
  checks.push({
    name: `Node.js ${process.versions.node}`,
    ok: nodeOk,
    detail: nodeOk ? 'native TypeScript support available' : 'too old',
    hint: nodeOk ? undefined : 'install Node.js 22.18+ (or 24 LTS) from nodejs.org',
  });

  try {
    await mkdir(dataDir, { recursive: true });
    const probeFile = resolve(dataDir, '.write-test');
    await writeFile(probeFile, 'ok', 'utf8');
    await unlink(probeFile);
    checks.push({ name: 'session folder', ok: true, detail: dataDir });
  } catch (err) {
    checks.push({
      name: 'session folder',
      ok: false,
      detail: `${dataDir}: ${(err as Error).message}`,
      hint: 'set EZSCAN_DATA_DIR to a writable folder',
    });
  }

  try {
    await access(process.cwd(), constants.R_OK);
  } catch {
    /* ignore */
  }

  // Why this is not just "did DNS answer": on a filtered line the resolver *does* answer —
  // with the block page. Every domain source then probes an address that was never the
  // host's and the scan looks broken for no visible reason. The two rows below separate
  // "the resolver is tampered with" from "Cloudflare is unreachable".
  const answers: Array<{ name: string; ips: string[]; reason: string | null }> = [];
  let dnsFailure = '';
  for (const name of DNS_PROBES) {
    try {
      const ips = await defaultResolve(name, 4);
      answers.push({ name, ips, reason: ips.map((ip) => hijackReason(ip)).find(Boolean) ?? null });
    } catch (err) {
      dnsFailure = (err as Error).message;
    }
  }

  const doh = await resolveOverHttps('cloudflare.com', controller.signal);
  const suspicious = answers.find((entry) => entry.reason);
  let dnsHijack: DnsHijack | undefined;

  const describe = (entry: { name: string; ips: string[] }) =>
    `${entry.name} → ${entry.ips.slice(0, 3).join(', ') || 'no answer'}`;

  if (!answers.length) {
    checks.push({
      name: 'DNS lookup',
      ok: false,
      detail: dnsFailure || 'no answer',
      hint: 'the system resolver is not answering — check the DNS settings of the line',
    });
  } else if (suspicious) {
    dnsHijack = {
      name: suspicious.name,
      answer: suspicious.ips,
      reason: suspicious.reason!,
      viaDoh: doh?.ips ?? [],
      dohVia: doh?.via ?? null,
    };
    checks.push({
      name: 'DNS lookup',
      ok: false,
      detail: `${describe(suspicious)} — ${suspicious.reason}`,
      hint:
        'the resolver is answering with a filtered address, so any domain source probes the wrong host: ' +
        'use the Cloudflare/Paste source or an IP list (SNI is not resolved, so it is unaffected), and switch DNS to a resolver that is not tampered with',
    });
  } else {
    checks.push({ name: 'DNS lookup', ok: true, detail: answers.map(describe).join(' | ') });
  }

  if (!doh) {
    checks.push({
      name: 'DNS over HTTPS',
      ok: true,
      detail: 'neither 1.1.1.1 nor 8.8.8.8 could be reached, comparison skipped',
      hint: 'DoH is often blocked on a filtered line — if the DNS lookup above looks wrong, switch DNS before scanning domains',
    });
  } else {
    const systemIps = new Set(answers.find((entry) => entry.name === 'cloudflare.com')?.ips ?? []);
    const agrees = doh.ips.some((ip) => systemIps.has(ip));
    checks.push({
      name: `DNS over HTTPS via ${doh.via}`,
      ok: agrees,
      detail: agrees
        ? `cloudflare.com → ${doh.ips.join(', ')} — the system resolver agrees`
        : `cloudflare.com → ${doh.ips.join(', ')}, but the system resolver said ` +
          `${[...systemIps].join(', ') || 'nothing'} — the answer is being tampered with`,
      hint: agrees
        ? undefined
        : 'scan by IP (Cloudflare/Paste source) on this line, or change the resolver: domain sources cannot be trusted here',
    });
  }

  // Which edge the rows below dial. The fixed address is a last resort: a Cloudflare edge
  // that does not serve a name answers `403 error code: 1034`, so probing it with that
  // `sni` marks rows "ok" that proved nothing about the line (and let the throughput row
  // read an error page as a transfer). Each row now dials an address resolved for the name
  // it tests — the SNI itself for TLS/HTTP, the speed host for the transfer.
  const resolvedEdge = (name: string, fallback: string): string => {
    const entry = answers.find((candidate) => candidate.name === name && !candidate.reason && candidate.ips.length);
    return entry?.ips[0] ?? fallback;
  };
  const speedIp = resolvedEdge('speed.cloudflare.com', CF_PROBE_IP);
  let sniIp = CF_PROBE_IP;
  if (net.isIP(sampleSni) === 0) {
    try {
      sniIp = (await defaultResolve(sampleSni, 4))[0] ?? CF_PROBE_IP;
    } catch {
      /* unresolvable SNI: the fixed address at least proves the path to a Cloudflare edge */
    }
  }

  for (const canary of [
    { host: '1.1.1.1', port: 443 },
    { host: '8.8.8.8', port: 53 },
  ]) {
    const started = Date.now();
    try {
      const conn = await tcpConnect(canary.host, canary.port, { timeoutMs: 4000, signal: controller.signal });
      const ms = Date.now() - started;
      conn.socket.destroy();
      checks.push({ name: `TCP ${canary.host}:${canary.port}`, ok: true, detail: `${ms}ms` });
    } catch (err) {
      checks.push({
        name: `TCP ${canary.host}:${canary.port}`,
        ok: false,
        detail: (err as Error).message,
        hint: 'if both canaries fail the line itself is down or the operator blocked them — try a different network',
      });
    }
  }

  try {
    const conn = await tlsConnect(sniIp, 443, { timeoutMs: 6000, signal: controller.signal, sni: sampleSni });
    conn.socket.destroy();
    checks.push({ name: `TLS handshake ${sniIp} (sni=${sampleSni})`, ok: true, detail: 'handshake completed' });
  } catch (err) {
    checks.push({
      name: `TLS handshake ${sniIp} (sni=${sampleSni})`,
      ok: false,
      detail: (err as Error).message,
      hint: 'TLS is being interfered with on this line: try probe mode "tcp", a different SNI, or scan fewer addresses with the gentle preset',
    });
  }

  const cfg = { ...DEFAULT_CONFIG, sni: sampleSni, timeoutMs: 6000, minSuccesses: 1, tries: 1 };
  try {
    const attempt = await probeOnce({ ip: sniIp, port: 443, sni: sampleSni }, cfg, controller.signal);
    checks.push({
      name: 'HTTP through the edge',
      ok: attempt.ok,
      detail: attempt.ok ? `HTTP ${attempt.httpStatus} in ${Math.round(attempt.latencyMs)}ms (colo ${attempt.colo || '?'})` : `${attempt.error}: ${attempt.errorMessage ?? ''}`,
      hint: attempt.ok ? undefined : 'the edge answered TLS but not HTTP — lower timeout, or use mode "tls"/"tcp"',
    });
  } catch (err) {
    checks.push({ name: 'HTTP through the edge', ok: false, detail: (err as Error).message });
  }

  const speedBytes = 300_000;
  let transfer: LineSignature['transfer'];
  try {
    const down = await measureDownload(
      { ip: speedIp, port: 443, sni: sampleSni },
      { ...cfg, speedBytes, speedTimeoutMs: 8000 },
      controller.signal,
    );
    transfer = {
      bytes: down.bytes,
      targetBytes: speedBytes,
      stale: down.stale === true,
      idleMs: down.idleMs ?? 0,
      ...(down.error ? { error: down.error } : {}),
    };
    checks.push({
      name: `throughput endpoint ${speedIp}`,
      ok: down.ok,
      detail: down.ok
        ? `${down.mbps} Mbps over ${down.bytes} bytes`
        : `${down.error ?? 'failed'} after ${down.bytes} bytes`,
      hint: down.ok
        ? undefined
        : down.stale
          ? 'the transfer stopped moving rather than being slow: this is the MTU/PMTU signature of a PPPoE line, so scan with the mobin preset (or --no-speed)'
          : 'the speed endpoint did not deliver a transfer — set --speed-url to a URL your line can reach, or turn the speed phase off',
    });
  } catch (err) {
    checks.push({ name: 'throughput endpoint', ok: false, detail: (err as Error).message });
  }

  // The signature: what the line does to a burst, to repeated TLS handshakes, and (from the row
  // above) to a large transfer. This is the part that turns "the scan finds nothing" into a
  // parameter, because each mechanism maps onto a shipped preset rather than onto advice.
  let signature: LineSignature | undefined;
  let recommendation: LineRecommendation | undefined;
  try {
    signature = await measureLineSignature({ ip: sniIp, port: 443, sni: sampleSni }, controller.signal);
    if (transfer) signature.transfer = transfer;
    recommendation = classifyLine(signature);
    checks.push({ name: 'line signature', ok: true, detail: describeSignature(signature) });
    checks.push({
      name: 'recommended preset',
      ok: true,
      detail: recommendation.preset
        ? `--preset ${recommendation.preset}`
        : 'none — no operator-specific behaviour found, so scan with --preset standard',
      hint: recommendation.reasons.length ? recommendation.reasons.join('; ') : undefined,
    });
  } catch (err) {
    checks.push({ name: 'line signature', ok: true, detail: `not measured: ${(err as Error).message}` });
  }

  const failed = checks.filter((c) => !c.ok);
  const summary = failed.length
    ? `${failed.length}/${checks.length} checks failed: ${failed.map((c) => c.name).join(', ')}`
    : `all ${checks.length} checks passed — the scanner should work on this line`;
  return {
    ok: failed.length === 0,
    checks,
    summary,
    ...(dnsHijack ? { dnsHijack } : {}),
    ...(signature ? { signature } : {}),
    ...(recommendation?.preset ? { recommendation } : {}),
  };
}

interface SelfTestResult {
  probes: number;
  healthy: number;
  failures: Record<string, number>;
  sample: string[];
  verdict: string;
}

/**
 * `ezscan selftest`: probes a handful of real edges and explains what it saw, so
 * "nothing works" can be split into "my line is blocked" vs "my settings are wrong".
 */
export async function runSelfTest(sni: string, attempts = 12): Promise<SelfTestResult> {
  const { buildTargets } = await import('../core/ipsrc.ts');
  const { createResult, finalizeAll, recordAttempt } = await import('../core/scoring.ts');
  const expanded = await buildTargets({ kind: 'cloudflare', limit: attempts, seed: 42 }, { count: attempts, family: 4, seed: 42 });
  const cfg = { ...DEFAULT_CONFIG, sni, tries: 2, minSuccesses: 1, timeoutMs: 5000 };
  const controller = new AbortController();
  const failures: Record<string, number> = {};
  const results = [];
  const sample: string[] = [];
  for (const raw of expanded.targets) {
    const ip = raw.split(':')[0];
    const r = createResult(ip, cfg.port, sni);
    for (let t = 0; t < cfg.tries; t++) {
      const attempt = await probeOnce({ ip, port: cfg.port, sni }, cfg, controller.signal);
      recordAttempt(r, attempt);
      if (!attempt.ok) {
        failures[attempt.error ?? 'other'] = (failures[attempt.error ?? 'other'] ?? 0) + 1;
      }
    }
    if (r.successes > 0) sample.push(`${r.ip} ${Math.min(...r.latencies)}ms`);
    results.push(r);
  }
  const healthy = finalizeAll(results, cfg).filter((r) => r.healthy).length;
  let verdict: string;
  if (healthy >= Math.max(1, Math.round(attempts * 0.15))) {
    verdict = 'the scanner works on this line — if a real scan finds nothing, your filters (require WS / idle hold / score) are too strict';
  } else if ((failures['timeout'] ?? 0) > attempts) {
    verdict = 'mostly timeouts: TLS/handshake is being dropped. Try mode "tcp", a different SNI, or fewer workers';
  } else if ((failures['reset'] ?? 0) > attempts / 2) {
    verdict = 'mostly resets: something on the path is killing the connections. Lower the rate (gentle preset) and retry';
  } else {
    verdict = 'very few healthy edges: check the SNI, the port and whether the line can reach Cloudflare at all';
  }
  return { probes: results.length, healthy, failures, sample: sample.slice(0, 5), verdict };
}
