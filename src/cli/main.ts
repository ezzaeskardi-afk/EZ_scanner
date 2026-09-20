#!/usr/bin/env node
/**
 * EZ Scanner CLI.
 *
 *   ezscan scan --preset standard --count 5000 --sni my.sni.example
 *   ezscan gui
 *   ezscan resume <session-id>
 *   ezscan doctor | selftest | config <link> | sessions | export
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseShareLink, isParsedConfig, describeConfig, sniRiskWarnings } from '../core/configparse.ts';
import { exportResults, summarize, type ExportFormat } from '../core/export.ts';
import { Scanner, defaultDataDir } from '../core/scanner.ts';
import { applyPreset, DEFAULT_CONFIG, PRESETS, type ScanConfig, type SourceSpec } from '../core/types.ts';
import { sanitizeConfig, sanitizeSource } from '../core/validate.ts';
import { createEzServer } from '../server/server.ts';
import { runDoctor, runSelfTest } from '../server/doctor.ts';
import { Output, RESULT_HEADERS, nextStepHints, printDoctor, resultRow } from './render.ts';

const VERSION = '1.5.0';

/* ───────────────────────────── arg parsing ───────────────────────────── */

interface Args {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

const BOOL_FLAGS = new Set([
  'extended',
  'ws',
  'no-ws',
  'http',
  'no-http',
  'speed',
  'upload',
  'no-backoff',
  'no-autopause',
  'no-early-exit',
  'dry-run',
  'quiet',
  'no-color',
  'help',
  'h',
  'json-console',
  'open',
  'no-open',
  'yes',
  'y',
  'list',
]);

const ALIASES: Record<string, string> = {
  n: 'count',
  c: 'count',
  w: 'workers',
  t: 'timeout',
  o: 'out',
  h: 'help',
  v: 'version',
};

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      args.positional.push(token);
      continue;
    }
    const name = token.replace(/^--?/, '');
    const key = ALIASES[name] ?? name;
    if (BOOL_FLAGS.has(key)) {
      args.flags.add(key);
      continue;
    }
    const inline = token.includes('=') ? token.split('=').slice(1).join('=') : null;
    if (inline !== null) {
      args.values.set(key, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key);
      continue;
    }
    args.values.set(key, next);
    i++;
  }
  return args;
}

function num(args: Args, key: string, fallback: number): number {
  const raw = args.values.get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function buildConfig(args: Args): { config: ScanConfig; warnings: string[] } {
  let patch: Partial<ScanConfig> = {};
  const presetName = args.values.get('preset');
  if (presetName) {
    const preset = applyPreset(presetName);
    if (!preset) throw new Error(`unknown preset "${presetName}" (have: ${Object.keys(PRESETS).join(', ')}, iran)`);
    patch = { ...preset };
  }

  const set = (key: keyof ScanConfig, value: unknown, present: boolean) => {
    if (present) (patch as Record<string, unknown>)[key] = value;
  };
  set('mode', args.values.get('mode'), args.values.has('mode'));
  set('port', num(args, 'port', DEFAULT_CONFIG.port), args.values.has('port'));
  set('sni', args.values.get('sni') ?? '', args.values.has('sni'));
  set('sniPool', (args.values.get('sni-pool') ?? '').split(',').map((s) => s.trim()).filter(Boolean), args.values.has('sni-pool'));
  set('tries', num(args, 'tries', DEFAULT_CONFIG.tries), args.values.has('tries'));
  set('minSuccesses', num(args, 'min', DEFAULT_CONFIG.minSuccesses), args.values.has('min'));
  set('timeoutMs', num(args, 'timeout', DEFAULT_CONFIG.timeoutMs), args.values.has('timeout'));
  set('workers', num(args, 'workers', DEFAULT_CONFIG.workers), args.values.has('workers'));
  set('maxLatencyMs', num(args, 'latency', DEFAULT_CONFIG.maxLatencyMs), args.values.has('latency'));
  set('maxLossPct', num(args, 'loss', DEFAULT_CONFIG.maxLossPct), args.values.has('loss'));
  set('minScore', num(args, 'score', DEFAULT_CONFIG.minScore), args.values.has('score'));
  set('httpPath', args.values.get('http-path') ?? '/', args.values.has('http-path'));
  set('wsPath', args.values.get('ws-path') ?? '/', args.values.has('ws-path'));
  set('stabilityMs', num(args, 'idle', DEFAULT_CONFIG.stabilityMs), args.values.has('idle'));
  set('requireHttp', true, args.flags.has('http'));
  set('requireHttp', false, args.flags.has('no-http'));
  set('requireWs', true, args.flags.has('ws'));
  set('requireWs', false, args.flags.has('no-ws'));
  set('earlyExit', false, args.flags.has('no-early-exit'));
  set('measureSpeed', true, args.flags.has('speed'));
  set('measureUpload', true, args.flags.has('upload'));
  set('speedBytes', num(args, 'speed-bytes', DEFAULT_CONFIG.speedBytes), args.values.has('speed-bytes'));
  set('uploadBytes', num(args, 'upload-bytes', DEFAULT_CONFIG.uploadBytes), args.values.has('upload-bytes'));
  set('speedUrl', args.values.get('speed-url') ?? DEFAULT_CONFIG.speedUrl, args.values.has('speed-url'));
  set('speedSni', args.values.get('speed-sni') ?? '', args.values.has('speed-sni'));
  set('topN', num(args, 'top', DEFAULT_CONFIG.topN), args.values.has('top'));
  set('rateLimitPerSec', num(args, 'rate', DEFAULT_CONFIG.rateLimitPerSec), args.values.has('rate'));
  set('minDelayMs', num(args, 'delay', DEFAULT_CONFIG.minDelayMs), args.values.has('delay'));
  set('adaptiveBackoff', false, args.flags.has('no-backoff'));
  set('autoPauseOnNetworkLoss', false, args.flags.has('no-autopause'));
  // `--canary host:port`: the port used to be dropped, so the watchdog always dialled 443.
  const canary = args.values.get('canary') ?? '';
  const [canaryHost, canaryPort] = canary.split(':');
  set('canaryHost', canaryHost || DEFAULT_CONFIG.canaryHost, args.values.has('canary'));
  set('canaryPort', Number(canaryPort) || DEFAULT_CONFIG.canaryPort, args.values.has('canary') && Boolean(canaryPort));
  set('family', num(args, 'family', DEFAULT_CONFIG.family), args.values.has('family'));

  const { config, warnings } = sanitizeConfig(patch, DEFAULT_CONFIG);
  return { config, warnings };
}

async function buildSource(args: Args): Promise<SourceSpec> {
  const kind = (args.values.get('source') ?? 'cloudflare') as SourceSpec['kind'];
  const inline = async (value: string | undefined): Promise<string> => {
    if (!value) return '';
    try {
      return await readFile(value, 'utf8');
    } catch {
      return value; // treat it as a literal list
    }
  };
  const base: SourceSpec = {
    kind,
    limit: num(args, 'count', 5000),
    seed: num(args, 'seed', 1337),
    extended: args.flags.has('extended'),
  };
  if (kind === 'file') base.path = args.values.get('file') ?? args.values.get('targets') ?? '';
  if (kind === 'paste') base.text = await inline(args.values.get('targets') ?? args.values.get('paste'));
  if (kind === 'domains') base.text = await inline(args.values.get('domains'));
  if (kind === 'config') base.config = args.values.get('config') ?? '';
  return sanitizeSource(base);
}

/* ───────────────────────────── commands ───────────────────────────── */

function out0(args: Args): Output {
  return new Output({ color: !args.flags.has('no-color'), quiet: args.flags.has('quiet') });
}

function printResults(out: Output, results: ReturnType<Scanner['getResults']>, limit: number): void {
  const healthy = results.filter((r) => r.healthy);
  const list = (healthy.length ? healthy : results).slice(0, limit);
  if (!list.length) {
    out.line(out.paint('yellow', 'no reachable address found — see the hints below'));
    return;
  }
  out.table(RESULT_HEADERS, list.map(resultRow));
  if (results.length > limit) {
    out.line(out.paint('dim', `… ${results.length - limit} more rows (use --csv/--json/--xlsx to get everything)`));
  }
  out.line('');
  out.line(out.paint('green', summarize(results)));
}

function printFailureBreakdown(out: Output, scanner: Scanner): void {
  const { samples, byKind } = scanner.getFailures();
  const kinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
  if (!kinds.length) return;
  out.line('');
  out.line(out.paint('bold', 'why the rest failed'));
  out.line(`  ${kinds.map(([kind, count]) => `${kind}: ${count}`).join('  ·  ')}`);
  for (const sample of samples.slice(0, 5)) {
    out.line(out.paint('dim', `  ${sample.ip}:${sample.port} → ${sample.reasons[0] ?? sample.lastError ?? 'unknown'}`));
  }
  const dominant = kinds[0][0];
  const advice: Record<string, string> = {
    timeout: 'timeouts usually mean the handshake is dropped: try --mode tcp, a different --sni, or fewer --workers',
    reset: 'resets mean something on the path kills connections: lower the rate (--preset gentle) and retry',
    refused: 'refused means nothing is listening on that port: check --port and the range you are scanning',
    http: 'TLS worked but HTTP did not: raise --timeout or set --mode tls',
    ws: 'the WebSocket gate failed everywhere: leave --no-ws (default) unless your client really uses ws',
    unstable: 'the idle hold rejected everything: it is the strictest gate — turn it off (--idle 0)',
    tls: 'TLS negotiation failed: the SNI is probably wrong for these addresses',
  };
  if (advice[dominant]) out.line(out.paint('yellow', `  → ${advice[dominant]}`));
}

async function cmdScan(args: Args): Promise<number> {
  const out = out0(args);
  const { config, warnings } = buildConfig(args);
  const source = await buildSource(args);
  const scanner = new Scanner(defaultDataDir());
  const label = args.values.get('session');
  if (label) scanner.label = label;
  scanner.configure(config, source);

  scanner.on('log', (line) => out.log(line));
  scanner.on('progress', (stats) => out.stats(stats));

  if (args.flags.has('dry-run')) {
    const { buildTargets } = await import('../core/ipsrc.ts');
    const preview = await buildTargets(source, { count: source.limit ?? 0, family: config.family, seed: source.seed });
    out.line(`source: ${source.kind} → ${preview.targets.length} addresses (ranges ${preview.ranges}, domains ${preview.resolved})`);
    out.line(`sample: ${preview.targets.slice(0, 8).join(', ')}`);
    for (const note of preview.notes) out.line(out.paint('dim', `note: ${note}`));
    if (preview.errors.length) out.line(out.paint('yellow', `skipped: ${preview.errors.slice(0, 5).join(', ')}`));
    return 0;
  }

  for (const w of warnings) out.line(out.paint('yellow', `⚠ ${w}`));
  const stopping = () => {
    out.clearProgress();
    out.line(out.paint('yellow', 'stopping after the in-flight probes…'));
    void scanner.stop();
  };
  process.once('SIGINT', stopping);

  await scanner.start({ label });

  out.clearProgress();
  const results = scanner.getResults('score', { includeFailures: true });
  printResults(out, results, num(args, 'print', 30));
  printFailureBreakdown(out, scanner);

  // exports
  const jobs: Array<[string | undefined, ExportFormat]> = [
    [args.values.get('json'), 'json'],
    [args.values.get('csv'), 'csv'],
    [args.values.get('xlsx'), 'xlsx'],
    [args.values.get('txt'), 'txt'],
    [args.values.get('ndjson'), 'ndjson'],
    [args.values.get('links'), 'links'],
  ];
  let wrote = false;
  for (const [file, format] of jobs) {
    if (!file) continue;
    const payload = exportResults(results, format, {
      healthyOnly: !args.flags.has('all'),
      template: args.values.get('link-template') ?? args.values.get('config'),
      labelPrefix: args.values.get('prefix') ?? 'EZ',
    });
    await mkdir(dirname(resolve(file)), { recursive: true });
    await writeFile(file, payload.body);
    out.line(`wrote ${out.paint('cyan', file)} (${format})`);
    wrote = true;
  }
  if (wrote) out.line('');

  if (args.flags.has('json-console')) out.line(JSON.stringify(results.filter((r) => r.healthy), null, 2));

  if (!results.some((r) => r.healthy)) {
    out.line(out.paint('bold', 'what to try next'));
    for (const hint of nextStepHints()) out.line(`  • ${hint}`);
  }
  out.line(out.paint('dim', `session saved: ezscan resume ${scanner.sessionId.slice(0, 8)}`));
  return 0;
}

async function cmdResume(args: Args): Promise<number> {
  const out = out0(args);
  const id = args.positional[1];
  if (!id) {
    out.line('usage: ezscan resume <session-id|file.json>');
    return 1;
  }
  const scanner = new Scanner(defaultDataDir());
  const snapshot = await scanner.loadSnapshot(id);
  const overrides = args.values.size || args.flags.size ? buildConfig(args) : null;
  for (const w of overrides?.warnings ?? []) out.line(out.paint('yellow', `⚠ ${w}`));
  scanner.on('log', (line) => out.log(line));
  scanner.on('progress', (stats) => out.stats(stats));
  process.once('SIGINT', () => {
    out.clearProgress();
    void scanner.stop();
  });
  await scanner.start({
    resumeFrom: snapshot,
    configOverride: overrides?.config,
    label: snapshot.label,
    skipSpeed: args.flags.has('no-speed'),
  });
  out.clearProgress();
  printResults(out, scanner.getResults('score', { includeFailures: true }), num(args, 'print', 30));
  printFailureBreakdown(out, scanner);
  return 0;
}

async function cmdSessions(args: Args): Promise<number> {
  const out = out0(args);
  const scanner = new Scanner(defaultDataDir());
  const action = args.positional[1] ?? 'list';
  if (action === 'delete') {
    const id = args.positional[2];
    if (!id) {
      out.line('usage: ezscan sessions delete <id>');
      return 1;
    }
    await scanner.deleteSession(id);
    out.line(`deleted ${id}`);
    return 0;
  }
  const sessions = await scanner.listSessions();
  if (!sessions.length) {
    out.line('no saved sessions yet');
    return 0;
  }
  out.table(
    ['id', 'label', 'progress', 'healthy', 'phase', 'updated'],
    sessions.map((s) => [
      s.id.slice(0, 8),
      s.label,
      `${s.done}/${s.total}`,
      String(s.healthy),
      s.phase,
      new Date(s.updatedAt).toLocaleString(),
    ]),
  );
  return 0;
}

async function cmdExport(args: Args): Promise<number> {
  const out = out0(args);
  const from = args.positional[1] ?? args.values.get('from');
  if (!from) {
    out.line('usage: ezscan export <session-id|file.json> --format csv|xlsx|json|txt|links --out file');
    return 1;
  }
  const scanner = new Scanner(defaultDataDir());
  const snapshot = await scanner.loadSnapshot(from);
  const format = (args.values.get('format') ?? 'csv') as ExportFormat;
  const results = snapshot.results;
  const payload = exportResults(results, format, {
    healthyOnly: !args.flags.has('all'),
    template: args.values.get('link-template'),
    labelPrefix: args.values.get('prefix') ?? 'EZ',
  });
  const target = args.values.get('out');
  if (target) {
    await mkdir(dirname(resolve(target)), { recursive: true });
    await writeFile(target, payload.body);
    out.line(`wrote ${target} (${format}, ${results.length} rows)`);
  } else {
    out.write(typeof payload.body === 'string' ? payload.body : payload.body.toString('utf8'));
  }
  return 0;
}

async function cmdGui(args: Args): Promise<number> {
  const out = out0(args);
  const server = await createEzServer({
    port: num(args, 'port', Number(process.env.EZSCAN_PORT ?? 8788)),
    dataDir: defaultDataDir(),
  });
  out.line(out.paint('bold', `EZ Scanner ${VERSION}`));
  out.line(`GUI:  ${out.paint('cyan', server.url)}`);
  out.line(`data: ${defaultDataDir()}`);
  out.line(out.paint('dim', 'press Ctrl+C to stop the server'));
  if (!args.flags.has('no-open')) openBrowser(`http://127.0.0.1:${server.port}/?token=${server.token}`);
  await new Promise<void>((resolvePromise) => {
    process.once('SIGINT', () => {
      out.line('\nshutting down…');
      void server.close().then(() => resolvePromise());
    });
  });
  return 0;
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const argv = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, argv, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* the user can open the URL by hand */
  }
}

async function cmdConfig(args: Args): Promise<number> {
  const out = out0(args);
  const link = args.positional.slice(1).join(' ') || args.values.get('link') || '';
  if (!link) {
    out.line('usage: ezscan config "vless://…"');
    return 1;
  }
  const parsed = parseShareLink(link);
  if (!isParsedConfig(parsed)) {
    out.line(out.paint('red', `cannot parse: ${parsed.error}`));
    return 1;
  }
  out.line(describeConfig(parsed));
  out.line(`address: ${parsed.address}   sni: ${parsed.sni || '(none)'}   port: ${parsed.port}`);
  for (const w of sniRiskWarnings(parsed)) out.line(out.paint('yellow', `⚠ ${w}`));
  out.line('');
  // The recommended command sweeps the Cloudflare ranges *with* this config's SNI — that
  // is the clean-IP workflow. It used to say `--source config … --count 3000`, which scans
  // only the config's own address (the count is inert there), so the tip led nowhere.
  const port = parsed.port === 443 ? '' : ` --port ${parsed.port}`;
  const sni = parsed.sni ? ` --sni ${parsed.sni}` : '';
  out.line(out.paint('bold', 'scan with these settings:'));
  out.line(`  ezscan scan --count 3000${sni}${port}`);
  out.line(out.paint('dim', `scan the config's own address instead:  ezscan scan --source config --config "${link.slice(0, 60)}…"`));
  out.line(out.paint('dim', 'tip: keep --no-ws (default) and, if the line is throttled, add --rate 12 --workers 20'));
  out.line(out.paint('dim', 'scan your own list later with:  ezscan scan --source paste --targets found.txt --sni …'));
  return 0;
}

async function cmdDoctor(args: Args): Promise<number> {
  const out = out0(args);
  out.progress('running checks…', true);
  const report = await runDoctor(defaultDataDir(), args.values.get('sni') ?? 'www.cloudflare.com');
  out.clearProgress();
  printDoctor(out, report);
  return report.ok ? 0 : 2;
}

async function cmdSelfTest(args: Args): Promise<number> {
  const out = out0(args);
  const sni = args.values.get('sni') ?? 'www.cloudflare.com';
  const attempts = num(args, 'count', 12);
  out.line(`probing ${attempts} random Cloudflare edges with sni=${sni} …`);
  const result = await runSelfTest(sni, attempts);
  out.line('');
  out.table(
    ['probes', 'healthy', 'failures'],
    [[String(result.probes), String(result.healthy), Object.entries(result.failures).map(([k, v]) => `${k}:${v}`).join(' ') || '-']],
  );
  if (result.sample.length) out.line(`examples: ${result.sample.join(', ')}`);
  out.line('');
  out.line(out.paint(result.healthy > 0 ? 'green' : 'yellow', result.verdict));
  return result.healthy > 0 ? 0 : 2;
}

function usage(): string {
  return `EZ Scanner ${VERSION} — clean-IP discovery (Cloudflare / SNI tunnels)

usage: ezscan <command> [options]

commands
  gui                       start the local GUI (browser) — recommended
  scan                      run a scan from the terminal
  resume <id|file.json>     continue a saved session
  sessions [delete <id>]    list or delete saved sessions
  export <id|file.json>     export a saved session without re-scanning
  doctor                    diagnose the line (DNS, TCP, TLS, HTTP, speed)
  selftest                  probe a few edges and explain what it saw
  config "<share link>"     show the SNI/port/transport of your config

scan options
  --source cloudflare|paste|file|domains|config
  --count, -n <n>           how many addresses to draw (default 5000)
  --file <path> | --targets <path|list> | --domains <path|list>
  --config "<link>"         take SNI/port from your config, scan its domain
  --preset fast|standard|strict|gentle|irancell|mci|mobin
  --mode tcp|tls|http       probe depth (default tls)
  --port <n> --sni <domain> --sni-pool a,b
  --tries <n> --min <n>     attempts per address / required successes
  --timeout <ms> --workers <n> --latency <ms> --loss <pct> --score <n>
  --ws / --no-ws            require a WebSocket upgrade (default: off)
  --idle <ms>               idle-hold DPI check (default: off)
  --no-http                 skip the HTTP response check
  --speed --speed-bytes <n> --upload --top <n> --speed-url <url> --speed-sni <host>
  --rate <n> --delay <ms> --no-backoff --no-autopause --canary host:port
  --family 4|6|0            address family
  --json/--csv/--xlsx/--txt/--ndjson/--links <file>   write results
  --link-template "<link>"  template used for --links
  --session "<label>"       label for the autosaved session
  --dry-run                 only expand the source and show the count
  --no-color --quiet --print <n>

examples
  ezscan scan --preset gentle --count 2000 --sni my.sni.example --csv out.csv
  ezscan scan --source config --config "vless://…" --speed --xlsx found.xlsx
  ezscan resume a1b2c3d4
  ezscan doctor
`;
}

/* ───────────────────────────── entry ───────────────────────────── */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0] ?? (args.flags.has('help') ? 'help' : 'gui');
  if (args.flags.has('version') || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  switch (command) {
    case 'gui':
      return cmdGui(args);
    case 'scan':
      return cmdScan(args);
    case 'resume':
      return cmdResume(args);
    case 'sessions':
      return cmdSessions(args);
    case 'export':
      return cmdExport(args);
    case 'doctor':
      return cmdDoctor(args);
    case 'selftest':
    case 'self-test':
      return cmdSelfTest(args);
    case 'config':
      return cmdConfig(args);
    case 'help':
    case '--help':
      process.stdout.write(usage());
      return 0;
    default:
      process.stdout.write(`unknown command "${command}"\n\n${usage()}`);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
