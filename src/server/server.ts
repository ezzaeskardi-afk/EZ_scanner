/**
 * Local GUI backend.
 *
 * Binds to 127.0.0.1 only, refuses cross-origin calls and requires a per-run
 * token on every mutating request, so a stray web page cannot start a scan on
 * the user's machine.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTargets } from '../core/ipsrc.ts';
import { Scanner, resultKey, type ScannerState } from '../core/scanner.ts';
import { describeConfig, isParsedConfig, parseShareLink, sniRiskWarnings } from '../core/configparse.ts';
import { exportResults, summarize, type ExportFormat } from '../core/export.ts';
import { buildOpenUiReport } from '../core/openui.ts';
import { applyPreset, type IpResult, type LogLine, type ScanConfig, type SourceSpec } from '../core/types.ts';
import { sanitizeConfig, sanitizeSource } from '../core/validate.ts';
import { runDoctor } from './doctor.ts';

const VERSION = '1.1.0';
const MAX_BODY = 32 * 1024 * 1024;

export interface EzServerOptions {
  scanner?: Scanner;
  host?: string;
  port?: number;
  dataDir?: string;
}

export interface EzServer {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  token: string;
  scanner: Scanner;
  close(): Promise<void>;
}

interface SseClient {
  res: http.ServerResponse;
  id: string;
}

export async function createEzServer(opts: EzServerOptions = {}): Promise<EzServer> {
  const token = randomUUID();
  const scanner = opts.scanner ?? new Scanner(opts.dataDir);
  const host = opts.host ?? '127.0.0.1';
  const guiDir = fileURLToPath(new URL('../gui/', import.meta.url));
  const clients = new Set<SseClient>();
  let pendingResults = new Map<string, IpResult>();
  let pendingLogs: LogLine[] = [];

  const send = (client: SseClient, event: string, data: unknown): void => {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(client);
    }
  };
  const broadcast = (event: string, data: unknown): void => {
    for (const client of [...clients]) send(client, event, data);
  };

  scanner.on('result', (result) => pendingResults.set(resultKey(result.ip, result.port), result));
  scanner.on('log', (line) => {
    pendingLogs.push(line);
    if (pendingLogs.length > 200) pendingLogs = pendingLogs.slice(-100);
  });
  scanner.on('progress', (stats) => broadcast('progress', stats));
  scanner.on('network', (state) => broadcast('network', state));
  scanner.on('state', (payload) => broadcast('state', { state: payload.state, stats: payload.stats }));
  scanner.on('phase', (payload) => broadcast('phase', payload));
  scanner.on('done', (payload) => {
    broadcast('done', { stats: payload.stats, summary: summarize(payload.results) });
  });

  const flush = setInterval(() => {
    if (pendingResults.size) {
      const batch = [...pendingResults.values()];
      pendingResults = new Map();
      broadcast('results', batch);
    }
    if (pendingLogs.length) {
      const logs = pendingLogs;
      pendingLogs = [];
      broadcast('logs', logs);
    }
  }, 300);

  const statePayload = async (query: URLSearchParams) => {
    const sort = (query.get('sort') ?? 'score') as Parameters<Scanner['getResults']>[0];
    const healthyOnly = query.get('healthyOnly') === '1';
    const limit = Math.min(20_000, Math.max(50, Number(query.get('limit') ?? 5000) || 5000));
    const all = scanner.getResults(sort, { healthyOnly, includeFailures: !healthyOnly });
    return {
      ok: true,
      version: VERSION,
      state: scanner.getState() as ScannerState,
      stats: scanner.getStats(),
      config: scanner.config,
      source: scanner.source,
      logs: scanner.getLogs().slice(-200),
      network: scanner.getNetwork(),
      totals: {
        results: scanner.results.size,
        healthy: [...scanner.results.values()].filter((r) => r.healthy).length,
        failures: scanner.failures.length,
      },
      results: all.slice(0, limit),
      truncated: all.length > limit,
      sessions: await scanner.listSessions(),
    };
  };

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const readJson = async <T>(req: http.IncomingMessage): Promise<T> => {
    const raw = await readBody(req);
    if (!raw) return {} as T;
    return JSON.parse(raw) as T;
  };

  const serveStatic = async (res: http.ServerResponse, pathname: string, port: number): Promise<boolean> => {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = join(guiDir, safe);
    if (!file.startsWith(guiDir)) return false;
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
    };
    try {
      let body: Buffer | string = await readFile(file);
      const ext = extname(file);
      if (ext === '.html') {
        body = Buffer.from(
          body
            .toString('utf8')
            .replaceAll('__EZ_TOKEN__', token)
            .replaceAll('__EZ_VERSION__', VERSION)
            .replaceAll('__EZ_PORT__', String(port)),
          'utf8',
        );
      }
      res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  };

  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
    const pathname = url.pathname;

    try {
      // --- local-only guard -------------------------------------------------
      const hostHeader = String(req.headers.host ?? '');
      const hostName = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (hostName && !['127.0.0.1', 'localhost', '::1', ''].includes(hostName)) {
        json(res, 403, { ok: false, error: 'this server only answers on loopback' });
        return;
      }
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(origin))) {
        json(res, 403, { ok: false, error: 'cross-origin request rejected' });
        return;
      }
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating && pathname.startsWith('/api/') && req.headers['x-ez-token'] !== token) {
        json(res, 403, { ok: false, error: 'missing or wrong token' });
        return;
      }

      // --- static -----------------------------------------------------------
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        if (await serveStatic(res, pathname, port)) return;
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const client: SseClient = { res, id: randomUUID() };
        clients.add(client);
        res.write('retry: 2000\n\n');
        send(client, 'hello', { version: VERSION, state: scanner.getState(), stats: scanner.getStats() });
        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(keepAlive);
          }
        }, 15_000);
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(client);
        });
        return;
      }

      if (pathname === '/api/state') {
        json(res, 200, await statePayload(url.searchParams));
        return;
      }

      // OpenUI Lang dashboard of the current scan (rendered by /report.html).
      if (pathname === '/api/report/openui' && req.method === 'GET') {
        const language = url.searchParams.get('lang') === 'en' ? 'en' : 'fa';
        const report = buildOpenUiReport({
          stats: scanner.getStats(),
          config: scanner.config,
          source: scanner.source,
          state: scanner.getState(),
          results: scanner.getResults('score'),
          failures: scanner.getFailures().samples,
          version: VERSION,
          language,
          topN: Number(url.searchParams.get('top') ?? 25) || 25,
        });
        if (url.searchParams.get('download') === '1') {
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="ez-scanner-report.openui.md"`,
          });
          res.end(report.code);
          return;
        }
        json(res, 200, { ok: true, ...report });
        return;
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        const body = await readJson<{ config?: Partial<ScanConfig>; source?: SourceSpec }>(req);
        const { config, warnings } = sanitizeConfig(body.config ?? {}, scanner.config);
        const source = body.source ? sanitizeSource(body.source, scanner.source) : undefined;
        try {
          scanner.configure(config, source);
        } catch (err) {
          json(res, 409, { ok: false, error: (err as Error).message });
          return;
        }
        broadcast('config', { config: scanner.config, source: scanner.source });
        json(res, 200, { ok: true, config: scanner.config, source: scanner.source, warnings });
        return;
      }

      if (pathname === '/api/preset' && req.method === 'POST') {
        const body = await readJson<{ name?: string }>(req);
        const preset = applyPreset(body.name ?? '');
        if (!preset) {
          json(res, 400, { ok: false, error: `unknown preset "${body.name}"` });
          return;
        }
        const { config, warnings } = sanitizeConfig(preset, scanner.config);
        scanner.configure(config);
        broadcast('config', { config: scanner.config, source: scanner.source });
        json(res, 200, { ok: true, config: scanner.config, source: scanner.source, warnings });
        return;
      }

      if (pathname === '/api/source/preview' && req.method === 'POST') {
        const body = await readJson<{ source?: SourceSpec }>(req);
        const source = sanitizeSource(body.source ?? {}, scanner.source);
        const preview = await buildTargets(source, {
          count: source.limit ?? 0,
          family: scanner.config.family,
          seed: source.seed,
        });
        json(res, 200, {
          ok: true,
          count: preview.targets.length,
          sample: preview.targets.slice(0, 20),
          ranges: preview.ranges,
          resolved: preview.resolved,
          notes: preview.notes,
          errors: preview.errors.slice(0, 20),
        });
        return;
      }

      if (pathname === '/api/config/parse' && req.method === 'POST') {
        const body = await readJson<{ config?: string }>(req);
        const parsed = parseShareLink(body.config ?? '');
        if (!isParsedConfig(parsed)) {
          json(res, 400, { ok: false, error: parsed.error });
          return;
        }
        json(res, 200, {
          ok: true,
          parsed,
          description: describeConfig(parsed),
          warnings: sniRiskWarnings(parsed),
        });
        return;
      }

      if (pathname === '/api/scan/start' && req.method === 'POST') {
        if (scanner.getState() === 'running' || scanner.getState() === 'paused' || scanner.getState() === 'offline') {
          json(res, 409, { ok: false, error: 'a scan is already running' });
          return;
        }
        const body = await readJson<{
          config?: Partial<ScanConfig>;
          source?: SourceSpec;
          mode?: 'fresh' | 'resume' | 'targets';
          targets?: string[];
          resumeId?: string;
          label?: string;
        }>(req);
        const { config, warnings } = sanitizeConfig(body.config ?? {}, scanner.config);
        const source = body.source ? sanitizeSource(body.source, scanner.source) : scanner.source;
        scanner.configure(config, source);

        let resumeFrom: Awaited<ReturnType<Scanner['loadSnapshot']>> | undefined;
        if (body.mode === 'resume') {
          if (!body.resumeId) {
            json(res, 400, { ok: false, error: 'resumeId is required to resume a session' });
            return;
          }
          resumeFrom = await scanner.loadSnapshot(body.resumeId);
        }
        const targets = body.mode === 'targets' ? (body.targets ?? []).map((t) => String(t)).filter(Boolean) : undefined;
        if (body.mode === 'targets' && !targets?.length) {
          json(res, 400, { ok: false, error: 'no addresses given' });
          return;
        }
        void scanner
          .start({ resumeFrom, targets, label: body.label })
          .catch((err) => broadcast('logs', [{ at: Date.now(), level: 'error', text: `scan failed: ${(err as Error).message}` }]));
        json(res, 200, { ok: true, state: scanner.getState(), warnings, targets: targets?.length });
        return;
      }

      if (pathname === '/api/scan/pause' && req.method === 'POST') {
        scanner.pause();
        json(res, 200, { ok: true, state: scanner.getState() });
        return;
      }
      if (pathname === '/api/scan/resume' && req.method === 'POST') {
        scanner.resume();
        json(res, 200, { ok: true, state: scanner.getState() });
        return;
      }
      if (pathname === '/api/scan/stop' && req.method === 'POST') {
        await scanner.stop();
        json(res, 200, { ok: true, state: scanner.getState() });
        return;
      }
      if (pathname === '/api/scan/save' && req.method === 'POST') {
        const file = await scanner.saveSnapshot();
        json(res, 200, { ok: true, file, sessions: await scanner.listSessions() });
        return;
      }

      if (pathname === '/api/retest' && req.method === 'POST') {
        const body = await readJson<{ keys?: string[]; mode?: 'probe' | 'speed' }>(req);
        const updated = await scanner.retest(body.keys ?? [], body.mode ?? 'speed');
        json(res, 200, { ok: true, updated: updated.length });
        return;
      }

      if (pathname === '/api/export' || pathname === '/api/export/inline') {
        const body = await readJson<{
          format?: ExportFormat;
          keys?: string[];
          healthyOnly?: boolean;
          template?: string;
          labelPrefix?: string;
          hidePort?: boolean;
          port?: number;
        }>(req);
        const format = (body.format ?? 'csv') as ExportFormat;
        const all = scanner.getResults('score');
        const selected = body.keys?.length ? all.filter((r) => body.keys!.includes(resultKey(r.ip, r.port))) : all;
        const parsed = body.template ? parseShareLink(body.template) : null;
        const payload = exportResults(selected, format, {
          healthyOnly: body.healthyOnly,
          template: body.template,
          config: parsed && isParsedConfig(parsed) ? parsed : null,
          labelPrefix: body.labelPrefix ?? 'EZ',
          hidePort: body.hidePort,
          port: body.port,
        });
        if (pathname === '/api/export/inline') {
          json(res, 200, {
            ok: true,
            filename: payload.filename,
            contentType: payload.contentType,
            text: Buffer.isBuffer(payload.body) ? payload.body.toString('base64') : payload.body,
            binary: Buffer.isBuffer(payload.body),
            count: selected.length,
          });
          return;
        }
        const buffer = Buffer.isBuffer(payload.body) ? payload.body : Buffer.from(payload.body, 'utf8');
        res.writeHead(200, {
          'Content-Type': payload.contentType,
          'Content-Disposition': `attachment; filename="${payload.filename}"`,
          'Content-Length': buffer.length,
        });
        res.end(buffer);
        return;
      }

      if (pathname === '/api/sessions' && req.method === 'GET') {
        json(res, 200, { ok: true, sessions: await scanner.listSessions() });
        return;
      }
      if (pathname === '/api/sessions/load' && req.method === 'POST') {
        const body = await readJson<{ id?: string }>(req);
        if (!body.id) {
          json(res, 400, { ok: false, error: 'id is required' });
          return;
        }
        const snapshot = await scanner.loadSnapshot(body.id);
        json(res, 200, {
          ok: true,
          session: { id: snapshot.id, label: snapshot.label, total: snapshot.targets.length, cursor: snapshot.cursor, healthy: snapshot.results.length },
        });
        return;
      }
      if (pathname === '/api/sessions/delete' && req.method === 'POST') {
        const body = await readJson<{ id?: string }>(req);
        if (body.id) await scanner.deleteSession(body.id);
        json(res, 200, { ok: true, sessions: await scanner.listSessions() });
        return;
      }
      if (pathname === '/api/sessions/import' && req.method === 'POST') {
        const body = await readJson<{ raw?: string }>(req);
        if (!body.raw) {
          json(res, 400, { ok: false, error: 'raw snapshot JSON is required' });
          return;
        }
        let parsed: Awaited<ReturnType<Scanner['loadSnapshot']>>;
        try {
          parsed = JSON.parse(body.raw) as Awaited<ReturnType<Scanner['loadSnapshot']>>;
        } catch (err) {
          json(res, 400, { ok: false, error: `invalid JSON: ${(err as Error).message}` });
          return;
        }
        if (!parsed || !Array.isArray(parsed.targets)) {
          json(res, 400, { ok: false, error: 'this file is not an EZ Scanner session snapshot' });
          return;
        }
        const dir = join(scanner.dataDir, 'sessions');
        await mkdir(dir, { recursive: true });
        const id = parsed.id || randomUUID();
        await writeFile(join(dir, `${id}.json`), JSON.stringify({ ...parsed, id }), 'utf8');
        await writeFile(
          join(dir, `${id}.meta.json`),
          JSON.stringify(
            {
              id,
              label: parsed.label || id.slice(0, 8),
              createdAt: parsed.createdAt ?? Date.now(),
              updatedAt: parsed.updatedAt ?? Date.now(),
              total: parsed.targets.length,
              done: parsed.cursor ?? 0,
              healthy: (parsed.results ?? []).filter((r) => r.healthy).length,
              phase: parsed.stats?.phase ?? 'stopped',
              file: join(dir, `${id}.json`),
            },
            null,
            2,
          ),
          'utf8',
        );
        json(res, 200, { ok: true, id, sessions: await scanner.listSessions() });
        return;
      }
      if (pathname === '/api/sessions/export' && req.method === 'POST') {
        const body = await readJson<{ id?: string }>(req);
        if (!body.id) {
          json(res, 400, { ok: false, error: 'id is required' });
          return;
        }
        const snapshot = await scanner.loadSnapshot(body.id);
        const filename = `ez-scanner-session-${snapshot.id.slice(0, 8)}.json`;
        const raw = JSON.stringify(snapshot, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': Buffer.byteLength(raw),
        });
        res.end(raw);
        return;
      }

      if (pathname === '/api/doctor' && req.method === 'POST') {
        const report = await runDoctor(scanner.dataDir);
        json(res, 200, { ok: true, report });
        return;
      }

      if (pathname === '/api/summary' && req.method === 'GET') {
        json(res, 200, { ok: true, summary: summarize(scanner.getResults('score')) });
        return;
      }

      if (pathname === '/api/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true, message: 'shutting down' });
        setTimeout(() => void close(), 150);
        return;
      }

      json(res, 404, { ok: false, error: `unknown endpoint ${pathname}` });
    } catch (err) {
      json(res, 500, { ok: false, error: (err as Error).message });
    }
  });

  const close = async (): Promise<void> => {
    clearInterval(flush);
    for (const client of clients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const desiredPort = opts.port ?? Number(process.env.EZSCAN_PORT ?? 8788);
  const port = await new Promise<number>((resolve, reject) => {
    const tryListen = (candidate: number, attempt: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 20) {
          tryListen(candidate + 1, attempt + 1);
          return;
        }
        reject(err);
      });
      server.listen(candidate, host, () => resolve((server.address() as { port: number }).port));
    };
    tryListen(desiredPort, 0);
  });

  return {
    server,
    port,
    host,
    url: `http://${host === '::1' ? '[::1]' : host}:${port}/?token=${token}`,
    token,
    scanner,
    close,
  };
}
