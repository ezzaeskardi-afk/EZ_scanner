/**
 * `ezscan doctor` / GUI diagnostics.
 *
 * Purpose: answer the single most common support question ("the scanner finds
 * nothing — is it the tool or my line?") without asking the user to read logs.
 */
import { access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG } from '../core/types.ts';
import { defaultResolve } from '../core/ipsrc.ts';
import { measureDownload, probeOnce } from '../core/probe.ts';
import { tcpConnect, tlsConnect } from '../core/net.ts';

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
}

const CF_PROBE_IP = '104.16.132.229';

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

  let dnsIps: string[] = [];
  try {
    dnsIps = await defaultResolve('cloudflare.com', 4);
    checks.push({ name: 'DNS lookup', ok: dnsIps.length > 0, detail: dnsIps.slice(0, 3).join(', ') || 'no answer' });
  } catch (err) {
    checks.push({
      name: 'DNS lookup',
      ok: false,
      detail: (err as Error).message,
      hint: 'the system resolver is not answering — check the DNS settings of the line',
    });
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
    const conn = await tlsConnect(CF_PROBE_IP, 443, { timeoutMs: 6000, signal: controller.signal, sni: sampleSni });
    conn.socket.destroy();
    checks.push({ name: `TLS handshake ${CF_PROBE_IP} (sni=${sampleSni})`, ok: true, detail: 'handshake completed' });
  } catch (err) {
    checks.push({
      name: `TLS handshake ${CF_PROBE_IP} (sni=${sampleSni})`,
      ok: false,
      detail: (err as Error).message,
      hint: 'TLS is being interfered with on this line: try probe mode "tcp", a different SNI, or scan fewer addresses with the gentle preset',
    });
  }

  const cfg = { ...DEFAULT_CONFIG, sni: sampleSni, timeoutMs: 6000, minSuccesses: 1, tries: 1 };
  try {
    const attempt = await probeOnce({ ip: CF_PROBE_IP, port: 443, sni: sampleSni }, cfg, controller.signal);
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
      { ip: CF_PROBE_IP, port: 443, sni: sampleSni },
      { ...cfg, speedBytes: 300_000, speedTimeoutMs: 8000 },
      controller.signal,
    );
    checks.push({
      name: 'throughput endpoint',
      ok: down.ok,
      detail: down.ok ? `${down.mbps} Mbps over ${down.bytes} bytes` : `${down.error ?? 'failed'}`,
      hint: down.ok ? undefined : 'speed.cloudflare.com is unreachable; set a custom speed URL that your line can reach',
    });
  } catch (err) {
    checks.push({ name: 'throughput endpoint', ok: false, detail: (err as Error).message });
  }

  const failed = checks.filter((c) => !c.ok);
  const summary = failed.length
    ? `${failed.length}/${checks.length} checks failed: ${failed.map((c) => c.name).join(', ')}`
    : `all ${checks.length} checks passed — the scanner should work on this line`;
  return { ok: failed.length === 0, checks, summary };
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
