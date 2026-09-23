/**
 * Terminal output.
 *
 * Accessibility note (issue #51): state is always carried by a symbol/word, not
 * by colour alone, and colour can be switched off entirely (`--no-color`,
 * `NO_COLOR`, or simply piping the output anywhere).
 */
import type { IpResult, ScanStats, LogLine, SpeedTrust } from '../core/types.ts';
import type { DoctorReport } from '../server/doctor.ts';

const CODES = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
};

interface OutputOptions {
  color?: boolean;
  quiet?: boolean;
}

export class Output {
  readonly color: boolean;
  readonly quiet: boolean;
  readonly tty: boolean;
  private lastProgress = '';

  constructor(opts: OutputOptions = {}) {
    this.tty = Boolean(process.stdout.isTTY);
    this.color = opts.color ?? (this.tty && !process.env.NO_COLOR);
    this.quiet = opts.quiet ?? false;
  }

  paint(code: keyof typeof CODES, text: string): string {
    return this.color ? `${CODES[code]}${text}${CODES.reset}` : text;
  }

  write(text: string): void {
    process.stdout.write(text);
  }

  line(text = ''): void {
    if (this.quiet) return;
    process.stdout.write(`${text}\n`);
  }

  /** Single-line, in-place status. Falls back to periodic lines when not a TTY. */
  progress(text: string, force = false): void {
    if (this.quiet) return;
    if (this.tty) {
      if (text === this.lastProgress) return;
      this.lastProgress = text;
      process.stdout.write(`\r\u001b[2K${text}`);
      return;
    }
    if (!force) return;
    process.stdout.write(`${text}\n`);
  }

  clearProgress(): void {
    if (this.tty && this.lastProgress) process.stdout.write('\r\u001b[2K');
    this.lastProgress = '';
  }

  log(line: LogLine): void {
    if (this.quiet) return;
    const tag = line.level === 'error' ? '!!' : line.level === 'warn' ? ' **' : line.level === 'ok' ? 'ok' : '..';
    const color: keyof typeof CODES = line.level === 'error' ? 'red' : line.level === 'warn' ? 'yellow' : line.level === 'ok' ? 'green' : 'dim';
    this.clearProgress();
    this.line(`${this.paint(color, tag)} ${line.text}`);
  }

  table(headers: string[], rows: string[][]): void {
    if (this.quiet) return;
    // Column count comes from the widest row as well as the header: a row with more cells than
    // headers used to read `widths[i]` past the end and `padEnd(undefined)`, which silently dropped
    // the padding (and with it the alignment) of every column after the extra cell.
    const columns = Math.max(headers.length, ...rows.map((r) => r.length));
    const widths = Array.from({ length: columns }, (_, i) =>
      Math.max(headers[i]?.length ?? 0, ...rows.map((r) => (r[i] ?? '').length)),
    );
    const render = (cells: string[]) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    this.line(this.paint('bold', render(headers)));
    this.line(this.paint('dim', widths.map((w) => '-'.repeat(w)).join('  ')));
    for (const row of rows) this.line(render(row));
  }

  stats(stats: ScanStats): void {
    const pct = stats.total ? ((stats.done / stats.total) * 100).toFixed(1) : '0.0';
    const eta = stats.etaMs ? `${Math.round(stats.etaMs / 1000)}s` : '-';
    this.progress(
      `[${stats.phase}] ${stats.done}/${stats.total} (${pct}%) ok=${stats.ok} fail=${stats.failed} healthy=${stats.healthy} rate=${stats.rate}/s eta=${eta}` +
        (stats.paused ? ' PAUSED' : '') +
        (stats.offline ? ' LINE-DOWN' : ''),
    );
  }
}

function healthTag(result: IpResult): string {
  if (result.healthy) return '[OK]';
  if (result.successes > 0) return '[--]';
  return '[!!]';
}

/**
 * The throughput cell.
 *
 * A gap here is not one fact: never tested, refused by the endpoint, cut by the path, stalled, and
 * truncated are five different answers to "is this address worth keeping", and a bare `-` says
 * only that the column is empty. The word behind the gap is the verdict the ranking reads; the
 * byte counts that led to it are in the log (`speed` phase).
 */
function speedCell(mbps: number, trust: SpeedTrust): string {
  if (mbps) return `${mbps}Mbps`;
  switch (trust) {
    case 'cut':
      return '!cut';
    case 'stalled':
      return '!stalled';
    case 'partial':
      return '!short';
    case 'rejected':
      return '!refused';
    default:
      return '-';
  }
}

export function resultRow(result: IpResult): string[] {
  return [
    healthTag(result),
    `${result.ip}:${result.port}`,
    result.medianLatency ? `${result.medianLatency}ms` : '-',
    `${result.lossPct}%`,
    speedCell(result.downMbps, result.downTrust),
    speedCell(result.upMbps, result.upTrust),
    String(result.score),
    result.httpStatus ? String(result.httpStatus) : '-',
    result.wsOk === null ? '-' : result.wsOk ? 'ws' : 'no-ws',
    result.colo || '-',
    result.healthy ? '' : result.reasons[0] ?? '',
  ];
}

export const RESULT_HEADERS = ['st', 'address', 'latency', 'loss', 'down', 'up', 'score', 'http', 'ws', 'colo', 'why'];

export function printDoctor(out: Output, report: DoctorReport): void {
  out.line(out.paint('bold', 'EZ Scanner — line diagnostics'));
  out.line('');
  for (const check of report.checks) {
    out.line(`${check.ok ? out.paint('green', '[ OK ]') : out.paint('red', '[FAIL]')} ${check.name} — ${check.detail}`);
    if (check.hint) out.line(`        ${out.paint('dim', `→ ${check.hint}`)}`);
  }
  if (report.recommendation?.preset) {
    out.line('');
    out.line(out.paint('yellow', `! This line has a signature — run it with --preset ${report.recommendation.preset}`));
    for (const reason of report.recommendation.reasons) out.line(`  ${reason}`);
    out.line(
      out.paint(
        'dim',
        `  → ezscan scan --preset ${report.recommendation.preset} --source cloudflare --count 200`,
      ),
    );
  } else if (report.recommendation?.reasons.length) {
    // No preset fits, but the measurement still has the answer the doctor exists to give: this
    // one is not a parameter to lower, it is the path itself. Printing nothing would leave the
    // user with "no operator-specific behaviour found" on a line where nothing completed.
    out.line('');
    out.line(out.paint('yellow', '! The measurement could not name a preset'));
    for (const reason of report.recommendation.reasons) out.line(`  ${reason}`);
  }
  if (report.dnsHijack) {
    const hijack = report.dnsHijack;
    out.line('');
    out.line(out.paint('yellow', '! DNS answers are being rewritten on this line'));
    out.line(`  ${hijack.name} → ${hijack.answer.join(', ')} (${hijack.reason})`);
    if (hijack.viaDoh.length) {
      out.line(`  DNS over HTTPS (via ${hijack.dohVia}) answers: ${hijack.viaDoh.join(', ')}`);
    }
    out.line(
      out.paint(
        'dim',
        '  → scan by IP (the Cloudflare or Paste source): a domain source would probe the filtered address',
      ),
    );
  }
  out.line('');
  out.line(report.ok ? out.paint('green', report.summary) : out.paint('yellow', report.summary));
}

export function nextStepHints(): string[] {
  return [
    'if everything is red: turn off "require WebSocket" and the idle hold, and use the gentle preset',
    'best SNI is the one from your own config:  ezscan config "vless://…"  then scan with it',
    'shorter feedback loop:  ezscan scan --preset fast --count 200 --mode tcp',
    'long scan: add --session "my run" and resume later with  ezscan resume <id>',
    'line gets cut mid-scan: lower --workers / set --rate 12 so the operator does not react',
    'unknown line:  ezscan doctor  measures what the line does and names the preset to scan with',
  ];
}
