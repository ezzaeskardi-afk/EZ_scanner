/**
 * OpenUI Lang report builder.
 *
 * Turns a finished (or running) scan into an *OpenUI Lang* document — the
 * line-oriented UI language from https://github.com/thesysdev/openui — so the
 * GUI can render a real dashboard (KPIs, charts, tables) with OpenUI's own
 * renderer instead of hand-rolled HTML.
 *
 * Two things matter here:
 *
 * 1. **No LLM involved.** OpenUI Lang is just a language; a program can emit it.
 *    Every statement below is generated deterministically from the scan state,
 *    which means the report is reproducible and testable (see
 *    `test/openui.test.ts`).
 * 2. **Only components from `openuiChatLibrary` are used, with positional
 *    argument order taken from their Zod schemas.** The library locks the root
 *    to a single `Card(children)` and rejects unknown components, so a typo
 *    would silently drop a whole subtree.
 */
import { median } from './scoring.ts';
import type { IpResult, ScanConfig, ScanStats, SourceSpec } from './types.ts';

interface OpenUiReportInput {
  stats: ScanStats;
  config: ScanConfig;
  results: IpResult[];
  /** Sampled addresses that never succeeded (used for the "why is it red?" panel). */
  failures?: IpResult[];
  source?: Partial<SourceSpec> & { kind?: string };
  state?: string;
  version?: string;
  /** Max rows in the cleanest-addresses table. */
  topN?: number;
  generatedAt?: number;
}

interface OpenUiReportCounts {
  addresses: number;
  reachable: number;
  healthy: number;
  failures: number;
  rows: number;
}

interface OpenUiReport {
  /** The OpenUI Lang document. */
  code: string;
  counts: OpenUiReportCounts;
  generatedAt: number;
}

/** Escapes a value for use as an OpenUI Lang string literal. */
function q(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

/** OpenUI Lang literals are JSON-ish: numbers must be unquoted and finite. */
function num(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

const LATENCY_BUCKETS: Array<{ label: string; max: number }> = [
  { label: '<100ms', max: 99 },
  { label: '100-199', max: 199 },
  { label: '200-399', max: 399 },
  { label: '400-799', max: 799 },
  { label: '800-1499', max: 1499 },
  { label: '1500+', max: Number.POSITIVE_INFINITY },
];

interface Words {
  title: string;
  subtitle: (parts: string[]) => string;
  checked: string;
  checkedSub: string;
  clean: string;
  cleanSub: string;
  median: string;
  medianSub: string;
  best: string;
  bestSub: string;
  download: string;
  downloadSub: string;
  loss: string;
  lossSub: string;
  latency: string;
  latencyHeader: string;
  latencySub: string;
  tableHeader: string;
  tableSub: string;
  colRank: string;
  colAddress: string;
  colLatency: string;
  colLoss: string;
  colScore: string;
  colColo: string;
  colDown: string;
  seriesName: string;
  failuresHeader: string;
  failuresSub: string;
  colReason: string;
  colCount: string;
  gatesHeader: string;
  verdictClean: string;
  verdictCleanBody: (count: number, best: string) => string;
  verdictGated: string;
  verdictGatedBody: (reasons: string) => string;
  verdictDead: string;
  verdictDeadBody: (reasons: string) => string;
  verdictIdle: string;
  verdictIdleBody: string;
  idleNote: string;
}

/** The report is English-only: one words table, no locale indirection. */
const WORDS: Words = {
  title: 'EZ Scanner — clean edge report',
  subtitle: (parts) => parts.filter(Boolean).join(' · '),
  checked: 'Checked',
  checkedSub: 'TCP/TLS probes finished',
  clean: 'Clean',
  cleanSub: 'passed every gate',
  median: 'Median',
  medianSub: 'latency across clean addresses',
  best: 'Best',
  bestSub: 'fastest single probe',
  download: 'Peak down',
  downloadSub: 'best throughput measured',
  loss: 'Avg loss',
  lossSub: 'share of failed probes',
  latency: 'Latency profile',
  latencyHeader: 'Latency profile',
  latencySub: 'how many addresses sit in each latency bucket',
  tableHeader: 'Cleanest addresses',
  tableSub: 'sorted by score — copy these into your client',
  colRank: '#',
  colAddress: 'Address',
  colLatency: 'Latency',
  colLoss: 'Loss',
  colScore: 'Score',
  colColo: 'Edge',
  colDown: 'Down',
  seriesName: 'Addresses',
  failuresHeader: 'Why addresses were dropped',
  failuresSub: 'most common failure kinds in the sample',
  colReason: 'Failure',
  colCount: 'Count',
  gatesHeader: 'Gates applied to this scan',
  verdictClean: 'Scan produced clean addresses',
  verdictCleanBody: (count, best) => `${count} address(es) passed every gate. Fastest healthy edge: ${best}.`,
  verdictGated: 'Every address was rejected by the gates',
  verdictGatedBody: (reasons) =>
    `Addresses answered but the health gates refused them: ${reasons}. Relax the gates (preset "Gentle") or raise max latency/loss before blaming the line.`,
  verdictDead: 'Nothing answered',
  verdictDeadBody: (reasons) =>
    `No address completed a probe: ${reasons}. That usually means the port/SNI or the network path is wrong, not that Cloudflare is down.`,
  verdictIdle: 'Nothing scanned yet',
  verdictIdleBody: 'Start a scan and this report fills in live.',
  idleNote: 'This report is generated from the last scan state — run a scan for real numbers.',
};

function aggregate(items: IpResult[] | undefined, pick: (r: IpResult) => Record<string, number> | undefined): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items ?? []) {
    for (const [kind, count] of Object.entries(pick(item) ?? {})) {
      counts.set(kind, (counts.get(kind) ?? 0) + count);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function humanKinds(entries: Array<[string, number]>, limit = 3): string {
  return entries
    .slice(0, limit)
    .map(([kind, count]) => `${kind} ×${count}`)
    .join(', ');
}

/**
 * Builds the OpenUI Lang document for a scan.
 *
 * The document is intentionally defensive: empty scans, scans with zero healthy
 * addresses and scans that only produced failures each get a different verdict
 * callout, and any panel that would render empty is left out of the root Card.
 */
export function buildOpenUiReport(input: OpenUiReportInput): OpenUiReport {
  const L = WORDS;
  const results = input.results ?? [];
  const failures = input.failures ?? [];
  const healthy = results.filter((r) => r.healthy);
  const stats = input.stats;
  const cfg = input.config;
  const generatedAt = input.generatedAt ?? Date.now();
  const topN = Math.max(1, Math.min(200, input.topN ?? 25));

  const latencies = healthy.map((r) => r.medianLatency).filter((v) => v > 0);
  const medianLatency = latencies.length ? median(latencies) : 0;
  const bestIp = [...healthy].sort((a, b) => a.medianLatency - b.medianLatency)[0];
  const best = bestIp?.medianLatency ?? 0;
  const down = healthy.reduce((max, r) => Math.max(max, r.downMbps || 0), 0);
  const loss = results.length ? results.reduce((sum, r) => sum + (r.lossPct || 0), 0) / results.length : 0;

  const rejection = aggregate(results.filter((r) => !r.healthy), (r) => {
    const out: Record<string, number> = {};
    for (const reason of r.reasons ?? []) out[reason] = (out[reason] ?? 0) + 1;
    return out;
  });
  const failureKinds = aggregate(failures, (r) => r.errorKinds);

  const rows = [...healthy].sort((a, b) => b.score - a.score || a.medianLatency - b.medianLatency).slice(0, topN);

  // ── statements ──
  const lines: string[] = [];
  const root: string[] = ['header', 'verdict'];

  const date = new Date(generatedAt);
  const subtitle = L.subtitle([
    date.toISOString().replace('T', ' ').slice(0, 16) + 'Z',
    `${cfg.mode} :${cfg.port}`,
    input.source?.kind ?? '',
    input.state ?? '',
    `v${input.version ?? '1.3.1'}`,
  ]);

  lines.push(`header = CardHeader(${q(L.title)}, ${q(subtitle)})`);

  // Verdict: the one thing a user reads first.
  if (!results.length && !failures.length && !stats?.total) {
    lines.push(`verdict = Callout("neutral", ${q(L.verdictIdle)}, ${q(L.verdictIdleBody)})`);
    lines.push(`idleNote = TextContent(${q(L.idleNote)}, "small")`);
    root.push('idleNote');
  } else if (healthy.length) {
    lines.push(
      `verdict = Callout("success", ${q(L.verdictClean)}, ${q(
        L.verdictCleanBody(healthy.length, bestIp ? `${bestIp.ip}:${bestIp.port}` : '—'),
      )})`,
    );
  } else if (results.length) {
    lines.push(
      `verdict = Callout("warning", ${q(L.verdictGated)}, ${q(L.verdictGatedBody(humanKinds(rejection) || 'no success at all'))})`,
    );
  } else {
    lines.push(
      `verdict = Callout("error", ${q(L.verdictDead)}, ${q(L.verdictDeadBody(humanKinds(failureKinds) || 'all probes timed out'))})`,
    );
  }

  // KPI cards (SnippetCardBlock needs at least two items).
  const kpis: string[] = [];
  kpis.push(
    kpi('checked', 'radar', 'info', L.checked, L.checkedSub, 'number', String(stats?.done ?? results.length + failures.length), `${stats?.total ?? 0} total`),
  );
  kpis.push(kpi('clean', 'shield-check', 'success', L.clean, L.cleanSub, 'number', String(healthy.length), rateOf(healthy.length, Math.max(1, stats?.done ?? results.length))));
  kpis.push(
    kpi('median', 'timer', 'neutral', L.median, L.medianSub, 'number', medianLatency ? `${Math.round(medianLatency)}ms` : '—', cfg.maxLatencyMs ? `cap ${cfg.maxLatencyMs}ms` : ''),
  );
  kpis.push(kpi('best', 'zap', 'success', L.best, L.bestSub, 'number', best ? `${Math.round(best)}ms` : '—', bestIp?.colo ? `edge ${bestIp.colo}` : ''));
  if (down > 0) {
    kpis.push(kpi('down', 'download', 'info', L.download, L.downloadSub, 'number', `${down.toFixed(1)}Mbps`, 'direct probe'));
  }
  kpis.push(kpi('loss', 'activity', loss > (cfg.maxLossPct || 50) ? 'warning' : 'neutral', L.loss, L.lossSub, 'number', `${loss.toFixed(1)}%`, `cap ${cfg.maxLossPct}%`));
  lines.push(`kpis = SnippetCardBlock([${kpis.map((_, i) => `kpi${i + 1}`).join(', ')}], "grid", true)`);
  kpis.forEach((kpiLines, i) => lines.push(kpiLines.replaceAll('%IDX%', String(i + 1))));
  root.push('kpis');

  // Gates as tags — answers "which gates were on?" at a glance.
  const gates = [
    `${cfg.mode}:${cfg.port}`,
    `${cfg.tries} tries · min ${cfg.minSuccesses}`,
    `timeout ${cfg.timeoutMs}ms`,
    cfg.sni ? `sni ${cfg.sni}` : 'no sni',
    `ws ${cfg.requireWs ? 'on' : 'off'}`,
    `idle ${cfg.stabilityMs}ms`,
    `http ${cfg.requireHttp ? 'on' : 'off'}`,
  ];
  lines.push(`gates = TagBlock([${gates.map((g) => q(g)).join(', ')}])`);
  root.push('gates');

  // Latency histogram — only when there is something to plot.
  if (healthy.length) {
    const buckets = LATENCY_BUCKETS.map(() => 0);
    for (const value of latencies) {
      const index = LATENCY_BUCKETS.findIndex((b) => value <= b.max);
      buckets[index === -1 ? LATENCY_BUCKETS.length - 1 : index] += 1;
    }
    lines.push(`chartHeader = InlineHeader(${q(L.latencyHeader)}, ${q(L.latencySub)})`);
    lines.push(`chartLabels = [${LATENCY_BUCKETS.map((b) => q(b.label)).join(', ')}]`);
    lines.push(`chartSeries = Series(${q(L.seriesName)}, [${buckets.map(num).join(', ')}])`);
    lines.push(`chart = BarChart(chartLabels, [chartSeries], "grouped", ${q('latency bucket')}, ${q(L.seriesName)})`);
    root.push('chartHeader', 'chart');
  }

  // Cleanest addresses.
  if (rows.length) {
    lines.push(`topHeader = InlineHeader(${q(L.tableHeader)}, ${q(L.tableSub)})`);
    lines.push(
      `topTable = Table([` +
        [
          `Col(${q(L.colRank)}, [${rows.map((_, i) => i + 1).join(', ')}])`,
          `Col(${q(L.colAddress)}, [${rows.map((r) => q(`${r.ip}:${r.port}`)).join(', ')}])`,
          `Col(${q(L.colLatency)}, [${rows.map((r) => q(`${Math.round(r.medianLatency || 0)}ms`)).join(', ')}])`,
          `Col(${q(L.colLoss)}, [${rows.map((r) => q(`${r.lossPct}%`)).join(', ')}])`,
          `Col(${q(L.colScore)}, [${rows.map((r) => num(r.score)).join(', ')}])`,
          `Col(${q(L.colColo)}, [${rows.map((r) => q(r.colo || '—')).join(', ')}])`,
          // Only show the throughput column when a speed test actually ran.
          ...(rows.some((r) => r.downMbps > 0)
            ? [`Col(${q(L.colDown)}, [${rows.map((r) => q(r.downMbps ? `${r.downMbps.toFixed(1)}Mbps` : '—')).join(', ')}])`]
            : []),
        ].join(', ') +
        `])`,
    );
    root.push('topHeader', 'topTable');
  }

  // Failure breakdown — the "why" behind a red scan.
  if (failureKinds.length) {
    lines.push(`failsHeader = InlineHeader(${q(L.failuresHeader)}, ${q(L.failuresSub)})`);
    lines.push(
      `failsTable = Table([` +
        [
          `Col(${q(L.colReason)}, [${failureKinds.slice(0, 8).map(([kind]) => q(kind)).join(', ')}])`,
          `Col(${q(L.colCount)}, [${failureKinds.slice(0, 8).map(([, count]) => count).join(', ')}], "number")`,
        ].join(', ') +
        `])`,
    );
    root.push('failsHeader', 'failsTable');
  }

  const code = `root = Card([${root.join(', ')}])\n${lines.join('\n')}\n`;

  return {
    code,
    counts: {
      addresses: stats?.total ?? results.length + failures.length,
      reachable: results.length,
      healthy: healthy.length,
      failures: failures.length,
      rows: rows.length,
    },
    generatedAt,
  };
}

function kpi(
  id: string,
  icon: string,
  iconVariant: string,
  title: string,
  subtitle: string,
  valueVariant: string,
  value: string,
  subtext: string,
): string {
  // `%IDX%` is replaced with the item's index once the array is known.
  return [
    `kpi%IDX% = SnippetCardItem(${q(id)}, kpi%IDX%lhs, kpi%IDX%rhs)`,
    `kpi%IDX%lhs = IconText(kpi%IDX%icon, ${q(iconVariant)}, "m", ${q(title)}, ${q(subtitle)}, false, "horizontal")`,
    `kpi%IDX%icon = Icon(${q(icon)}, "system")`,
    `kpi%IDX%rhs = BoldText(${q(valueVariant)}, ${q(value)}, ${q(subtext)}, "metric")`,
  ].join('\n');
}

function rateOf(part: number, total: number): string {
  if (!total) return '';
  return `${((part / total) * 100).toFixed(1)}% of checked`;
}
