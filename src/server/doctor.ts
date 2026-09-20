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

  try {
    const down = await measureDownload(
      { ip: speedIp, port: 443, sni: sampleSni },
      { ...cfg, speedBytes: 300_000, speedTimeoutMs: 8000 },
      controller.signal,
    );
    checks.push({
      name: `throughput endpoint ${speedIp}`,
      ok: down.ok,
      detail: down.ok
        ? `${down.mbps} Mbps over ${down.bytes} bytes`
        : `${down.error ?? 'failed'} after ${down.bytes} bytes`,
      hint: down.ok
        ? undefined
        : 'the speed endpoint did not deliver a transfer — set --speed-url to a URL your line can reach, or turn the speed phase off',
    });
  } catch (err) {
    checks.push({ name: 'throughput endpoint', ok: false, detail: (err as Error).message });
  }

  const failed = checks.filter((c) => !c.ok);
  const summary = failed.length
    ? `${failed.length}/${checks.length} checks failed: ${failed.map((c) => c.name).join(', ')}`
    : `all ${checks.length} checks passed — the scanner should work on this line`;
  return { ok: failed.length === 0, checks, summary, ...(dnsHijack ? { dnsHijack } : {}) };
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
