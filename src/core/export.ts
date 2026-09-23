/**
 * Output formats.
 *
 * All of them are dependency-free and copy/paste friendly, because "I cannot
 * copy or export the result" was one of the most common complaints (issues #44,
 * #90, #106, #110).
 */
import { rewriteLink, type ParsedConfig } from './configparse.ts';
import { isIpv6 } from './ipsrc.ts';
import type { IpResult } from './types.ts';
import { createZip } from './zip.ts';

export type ExportFormat = 'json' | 'csv' | 'txt' | 'xlsx' | 'links' | 'hosts' | 'ndjson';

interface ExportOptions {
  /** Template link used by the `links` format. */
  template?: string;
  /** Optional config object (kept separate from the template for label defaults). */
  config?: ParsedConfig | null;
  port?: number;
  labelPrefix?: string;
  /** Only export healthy rows. */
  healthyOnly?: boolean;
  /** Trim port from `links`/`hosts` output. */
  hidePort?: boolean;
}

interface ExportPayload {
  filename: string;
  contentType: string;
  body: string | Buffer;
}

const CSV_COLUMNS: Array<{ key: string; get: (r: IpResult) => string | number }> = [
  { key: 'ip', get: (r) => r.ip },
  { key: 'port', get: (r) => r.port },
  { key: 'sni', get: (r) => r.sni },
  { key: 'healthy', get: (r) => (r.healthy ? 'yes' : 'no') },
  { key: 'score', get: (r) => r.score },
  { key: 'median_ms', get: (r) => r.medianLatency },
  { key: 'best_ms', get: (r) => r.bestLatency },
  { key: 'jitter_ms', get: (r) => r.jitter },
  { key: 'loss_pct', get: (r) => r.lossPct },
  { key: 'successes', get: (r) => r.successes },
  { key: 'attempts', get: (r) => r.attempts },
  { key: 'http_status', get: (r) => r.httpStatus },
  { key: 'ws', get: (r) => (r.wsOk === null ? 'n/a' : r.wsOk ? 'ok' : 'fail') },
  { key: 'stable', get: (r) => (r.stable === null ? 'n/a' : r.stable ? 'yes' : 'no') },
  { key: 'down_mbps', get: (r) => r.downMbps },
  { key: 'up_mbps', get: (r) => r.upMbps },
  { key: 'colo', get: (r) => r.colo },
  { key: 'first_seen', get: (r) => new Date(r.firstSeenAt).toISOString() },
  { key: 'last_seen', get: (r) => new Date(r.lastSeenAt).toISOString() },
  { key: 'reasons', get: (r) => r.reasons.join('; ') },
  // Appended, not inserted: the columns before it are what a spreadsheet already parses. The
  // flag is the recovery pass saying "this address was found on the second chance", which is the
  // difference between a lucky sweep and a line that blocked part of it.
  { key: 'recovered', get: (r) => (r.recovered ? 'yes' : 'no') },
  // The throughput column on its own cannot be read: a `0` means "never tested", "the endpoint
  // refused", "the path cut it", "it stalled" and "it stopped sending early" at once, and those
  // five are opposite verdicts on an address. The word beside the number is what makes it mean
  // something once it leaves the terminal — `measured` is the only one `down_mbps` counts for.
  { key: 'down_trust', get: (r) => r.downTrust },
  { key: 'up_trust', get: (r) => r.upTrust },
];

function csvCell(value: string | number): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(results: IpResult[]): string {
  const head = CSV_COLUMNS.map((c) => c.key).join(',');
  const rows = results.map((r) => CSV_COLUMNS.map((c) => csvCell(c.get(r))).join(','));
  // BOM so Excel opens UTF-8 correctly.
  return `\uFEFF${[head, ...rows].join('\r\n')}\r\n`;
}

function toJson(results: IpResult[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ generatedAt: new Date().toISOString(), count: results.length, ...extra, results }, null, 2);
}

function toNdjson(results: IpResult[]): string {
  return `${results.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

/** `ip:port`, with IPv6 bracketed so the value can be pasted back in. */
function formatAddress(ip: string, port: number, withPort = true): string {
  if (isIpv6(ip)) return withPort ? `[${ip}]:${port}` : ip;
  return withPort ? `${ip}:${port}` : ip;
}

export function toTxt(results: IpResult[], hidePort = false): string {
  return `${results.map((r) => formatAddress(r.ip, r.port, !hidePort)).join('\n')}\n`;
}

export function toHosts(results: IpResult[]): string {
  return `${results.map((r) => r.ip).join('\n')}\n`;
}

/** One share link per discovered address, ready to import into the client. */
/**
 * An address no template can already contain, used to prove the template can hold one.
 * TEST-NET-3 (RFC 5737) is reserved for documentation, so it is never a real result.
 */
const TEMPLATE_PROBE_IP = '203.0.113.9';

export function toLinks(results: IpResult[], opts: ExportOptions): string {
  const template = opts.template?.trim();
  if (!template) {
    throw new Error('no config template: paste a vless://, trojan:// or vmess:// link first');
  }
  // The rewrite is the whole feature, and when it could not rewrite anything it returned the
  // template untouched — so pasting an Xray/v2ray JSON document (which is not a link) into the
  // template box wrote one copy of that JSON per address, and a link the rewriter did not
  // understand wrote N copies of the *original* server. Proving it first turns both into the one
  // thing the user needs: an error that says the template is not a link to inject into.
  if (rewriteLink(template, TEMPLATE_PROBE_IP) === template) {
    throw new Error(
      'this template cannot carry an address: paste a single vless://, trojan://, vmess:// or ss:// link (a JSON config document is not a link)',
    );
  }
  const lines = results.map((r) => {
    const label = `${opts.labelPrefix ?? 'EZ'}-${r.ip}${r.medianLatency ? `-${r.medianLatency}ms` : ''}${r.downMbps ? `-${r.downMbps}M` : ''}`;
    return rewriteLink(template, r.ip, opts.port && opts.port !== r.port ? opts.port : undefined, { label });
  });
  return `${lines.join('\n')}\n`;
}

/* ----------------------------------- XLSX ----------------------------------- */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function columnName(index: number): string {
  let n = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

export function toXlsx(results: IpResult[], sheetName = 'EZ Scanner'): Buffer {
  const header = CSV_COLUMNS.map((c) => c.key);
  const rows: Array<Array<string | number>> = [header, ...results.map((r) => CSV_COLUMNS.map((c) => c.get(r)))];
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => {
          const ref = `${columnName(colIndex)}${rowIndex + 1}`;
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

  return createZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

/* --------------------------------- dispatch --------------------------------- */

const CONTENT_TYPES: Record<ExportFormat, string> = {
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  ndjson: 'application/x-ndjson; charset=utf-8',
  links: 'text/plain; charset=utf-8',
  hosts: 'text/plain; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const EXTENSIONS: Record<ExportFormat, string> = {
  json: 'json',
  csv: 'csv',
  txt: 'txt',
  ndjson: 'ndjson',
  links: 'txt',
  hosts: 'txt',
  xlsx: 'xlsx',
};

export function exportResults(
  allResults: IpResult[],
  format: ExportFormat,
  opts: ExportOptions = {},
): ExportPayload {
  const results = opts.healthyOnly ? allResults.filter((r) => r.healthy) : allResults;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = EXTENSIONS[format];
  const filename = `ez-scanner-${stamp}.${ext}`;
  let body: string | Buffer;
  switch (format) {
    case 'csv':
      body = toCsv(results);
      break;
    case 'txt':
      body = toTxt(results, opts.hidePort);
      break;
    case 'json':
      body = toJson(results, {
        healthy: results.filter((r) => r.healthy).length,
        config: opts.config ? { protocol: opts.config.protocol, address: opts.config.address } : undefined,
      });
      break;
    case 'ndjson':
      body = toNdjson(results);
      break;
    case 'hosts':
      body = toHosts(results);
      break;
    case 'links':
      body = toLinks(results, opts);
      break;
    case 'xlsx':
      body = toXlsx(results);
      break;
    default:
      throw new Error(`unknown export format ${String(format)}`);
  }
  return { filename, contentType: CONTENT_TYPES[format], body };
}

/** Human-readable summary used by the CLI and the GUI footer. */
export function summarize(results: IpResult[]): string {
  const healthy = results.filter((r) => r.healthy);
  const withSpeed = healthy.filter((r) => r.downMbps > 0);
  const best = withSpeed.sort((a, b) => b.downMbps - a.downMbps)[0];
  const fastest = [...healthy].sort((a, b) => a.medianLatency - b.medianLatency)[0];
  const parts = [`${results.length} reachable`, `${healthy.length} healthy`];
  if (fastest) parts.push(`fastest ${fastest.medianLatency}ms (${fastest.ip})`);
  if (best) parts.push(`top speed ${best.downMbps} Mbps (${best.ip})`);
  // An empty speed column usually means nobody asked for one (`--speed`), but not always: the
  // phase can run and produce nothing because the transfers did not happen. The summary is the one
  // line a user reads before the table, so it says which of the two this was.
  const unusable = healthy.filter((r) => r.downTrust !== 'measured' && r.downTrust !== 'untested').length;
  if (unusable) parts.push(`${unusable} speed test${unusable === 1 ? '' : 's'} unusable`);
  return parts.join(' | ');
}
