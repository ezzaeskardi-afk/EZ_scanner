/**
 * Share-link and Xray/sing-box JSON handling.
 *
 * Two jobs live here:
 *  1. understand the user's own config so the scanner can reuse its SNI,
 *     port, host header and WS path (issue: "no SNI field in the GUI");
 *  2. put discovered clean IPs *back* into that config, so the result is a
 *     ready-to-import link instead of a raw address list (issue: "combine IPs
 *     with config").
 */

export interface ParsedConfig {
  protocol: string;
  address: string;
  port: number;
  sni: string;
  hostHeader: string;
  path: string;
  security: string;
  network: string;
  name: string;
  raw: string;
  warnings: string[];
}

interface ParseFailure {
  error: string;
}

function b64decode(input: string): string {
  let s = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

export function b64encode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/=+$/, '');
}

/**
 * Percent-decodes a link fragment, but never at the cost of the whole config: a single
 * stray `%` in the name ("My node %") used to make `decodeURIComponent` throw and the
 * link unparsable — losing the SNI/port/transport the scan needs. The raw text is a
 * perfectly good name when it cannot be decoded.
 */
function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray `%` is a typo, not a reason to lose the name: escape the lone ones and try
    // again, keeping the readable parts of the label.
    try {
      return decodeURIComponent(value.replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
    } catch {
      return value;
    }
  }
}

export function isParsedConfig(value: ParsedConfig | ParseFailure): value is ParsedConfig {
  return !('error' in value);
}

/** Parses any supported share link. Returns `{ error }` when it cannot. */
export function parseShareLink(input: string): ParsedConfig | ParseFailure {
  const raw = input.trim();
  if (!raw) return { error: 'empty config' };
  const scheme = raw.split(':')[0].toLowerCase();

  try {
    switch (scheme) {
      case 'vless':
      case 'trojan':
      case 'hysteria2':
      case 'hy2':
      case 'tuic':
        return parseUrlStyle(raw, scheme);
      case 'vmess':
        return parseVmess(raw);
      case 'ss':
        return parseShadowsocks(raw);
      default:
        break;
    }
  } catch (err) {
    return { error: `cannot parse ${scheme} link: ${(err as Error).message}` };
  }
  if (raw.startsWith('{')) return parseXrayJson(raw)[0] ?? { error: 'no outbound with a server found' };
  return { error: `unsupported scheme "${scheme}"` };
}

function parseUrlStyle(raw: string, scheme: string): ParsedConfig | ParseFailure {
  const url = new URL(raw.replace(/\s+/g, ''));
  const params = url.searchParams;
  const security = params.get('security') ?? (scheme === 'trojan' ? 'tls' : 'none');
  const network = params.get('type') ?? params.get('net') ?? 'tcp';
  const sni = params.get('sni') ?? params.get('peer') ?? params.get('host') ?? '';
  const warnings: string[] = [];
  if (scheme === 'hysteria2' || scheme === 'hy2' || scheme === 'tuic') {
    warnings.push(`${scheme} is QUIC-based: only the SNI/port can be reused, TCP probing does not apply`);
  }
  if (!url.hostname) return { error: 'missing address' };
  return {
    protocol: scheme === 'hy2' ? 'hysteria2' : scheme,
    address: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : defaultPort(scheme, security),
    sni: sni || url.hostname,
    hostHeader: params.get('host') ?? '',
    path: params.get('path') ?? '/',
    security,
    network,
    name: decodeFragment(url.hash.replace(/^#/, '')) || `${scheme}-${url.hostname}`,
    raw,
    warnings,
  };
}

function parseVmess(raw: string): ParsedConfig | ParseFailure {
  const payload = raw.slice('vmess://'.length).trim();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(b64decode(payload)) as Record<string, unknown>;
  } catch (err) {
    return { error: `vmess payload is not base64 JSON: ${(err as Error).message}` };
  }
  const address = String(json.add ?? '');
  if (!address) return { error: 'vmess payload has no "add" field' };
  const tls = String(json.tls ?? '');
  return {
    protocol: 'vmess',
    address,
    port: Number(json.port ?? 443),
    sni: String(json.sni ?? json.host ?? address),
    hostHeader: String(json.host ?? ''),
    path: String(json.path ?? '/'),
    security: tls || 'none',
    network: String(json.net ?? 'tcp'),
    name: String(json.ps ?? `vmess-${address}`),
    raw,
    warnings: [],
  };
}

function parseShadowsocks(raw: string): ParsedConfig | ParseFailure {
  const body = raw.slice('ss://'.length);
  const [main, hash = ''] = body.split('#');
  let decoded = main;
  if (!main.includes('@')) {
    try {
      decoded = b64decode(main);
    } catch {
      /* keep as-is and let the regex below fail loudly */
    }
  }
  const m = decoded.match(/^([^@]+)@\[?([^\]@:]+)\]?:(\d+)/);
  if (!m) return { error: 'unrecognised shadowsocks link' };
  return {
    protocol: 'ss',
    address: m[2],
    port: Number(m[3]),
    sni: m[2],
    hostHeader: '',
    path: '',
    security: 'none',
    network: 'tcp',
    name: decodeFragment(hash) || `ss-${m[2]}`,
    raw,
    warnings: ['shadowsocks has no TLS/SNI: Cloudflare-clean-IP technique does not apply'],
  };
}

/** Best-effort extraction from an Xray / v2ray / sing-box JSON config. */
export function parseXrayJson(text: string): ParsedConfig[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const out: ParsedConfig[] = [];
  const obj = doc as Record<string, unknown>;
  const outbounds = Array.isArray(obj.outbounds) ? (obj.outbounds as Record<string, unknown>[]) : [];
  for (const ob of outbounds) {
    const stream = (ob.streamSettings ?? {}) as Record<string, unknown>;
    let server = '';
    let port = 443;
    let sni = '';
    let network = 'tcp';
    let security = 'none';
    const settings = ob.settings as Record<string, unknown> | undefined;
    const vnext = Array.isArray(settings?.vnext) ? (settings?.vnext as Record<string, unknown>[]) : [];
    const servers = Array.isArray(settings?.servers) ? (settings?.servers as Record<string, unknown>[]) : [];
    if (vnext.length) {
      server = String(vnext[0].address ?? '');
      port = Number(vnext[0].port ?? 443);
    } else if (servers.length) {
      server = String(servers[0].address ?? '');
      port = Number(servers[0].port ?? 8388);
    }
    if (!server) continue;
    const tlsSettings = stream.tlsSettings as Record<string, unknown> | undefined;
    const reality = stream.realitySettings as Record<string, unknown> | undefined;
    if (tlsSettings) {
      sni = String(tlsSettings.serverName ?? '');
      security = 'tls';
    }
    if (reality) {
      sni = String(reality.serverName ?? sni);
      security = 'reality';
    }
    const ws = stream.wsSettings as Record<string, unknown> | undefined;
    if (ws) {
      network = 'ws';
    }
    out.push({
      protocol: String(ob.protocol ?? 'unknown'),
      address: server,
      port,
      sni: sni || server,
      hostHeader: String(ws?.headers ? ((ws.headers as Record<string, unknown>).Host ?? '') : ''),
      path: String(ws?.path ?? '/'),
      security,
      network,
      name: String(ob.tag ?? `outbound-${out.length}`),
      raw: text,
      warnings: [],
    });
  }
  return out;
}

function defaultPort(scheme: string, security: string): number {
  if (scheme === 'trojan') return 443;
  if (scheme === 'hysteria2' || scheme === 'hy2') return 443;
  if (scheme === 'tuic') return 443;
  return security === 'tls' || security === 'reality' ? 443 : 80;
}

/**
 * Addresses a config points at, so the user can scan "whatever my config uses"
 * without hunting for ranges by hand.
 */
export function extractTargetsFromConfig(text: string): { hosts: string[]; error?: string } {
  const single = parseShareLink(text);
  if (isParsedConfig(single)) return { hosts: [single.address] };
  const many = parseXrayJson(text);
  if (many.length) return { hosts: many.map((c) => c.address) };
  return { hosts: [], error: single.error };
}

/**
 * Injects a clean IP back into a share link.
 * vless/trojan keep their UUID/params, vmess is re-encoded, ss gets host replaced.
 */
export function rewriteLink(
  raw: string,
  ip: string,
  port?: number,
  opts: { label?: string } = {},
): string {
  const trimmed = raw.trim();
  const scheme = trimmed.split(':')[0].toLowerCase();
  const hostPart = ip.includes(':') ? `[${ip}]` : ip;
  if (scheme === 'vmess') {
    try {
      const json = JSON.parse(b64decode(trimmed.slice('vmess://'.length))) as Record<string, unknown>;
      json.add = ip;
      if (port) json.port = String(port);
      if (opts.label) json.ps = opts.label;
      return `vmess://${Buffer.from(JSON.stringify(json), 'utf8').toString('base64')}`;
    } catch {
      return trimmed;
    }
  }
  if (scheme === 'ss') {
    const body = trimmed.slice('ss://'.length);
    const [main, hash = ''] = body.split('#');
    const replaced = main.replace(/(@?\[?[^@\]/:]+\]?):(\d+)/, `$1:${port ?? '$2'}`);
    const withHost = replaced.includes('@')
      ? replaced.replace(/@\[?[^\]/:]+\]?/, `@${hostPart}`)
      : replaced;
    return `ss://${withHost}${hash ? `#${hash}` : ''}`;
  }
  // Share links use non-special schemes, and the URL API refuses to set an
  // IPv6 host on those, so the authority is rewritten textually.
  const match = /^(?<scheme>[a-z0-9+.-]+:\/\/)(?<userinfo>[^@/?#]*@)?(?<host>\[[^\]]+\]|[^:/?#]+)(?<port>:\d+)?(?<rest>[^#]*)(?<hash>#.*)?$/i.exec(
    trimmed,
  );
  if (match?.groups) {
    const g = match.groups;
    const nextPort = port ? `:${port}` : (g.port ?? '');
    const nextHash = opts.label ? `#${opts.label}` : (g.hash ?? '');
    return `${g.scheme}${g.userinfo ?? ''}${hostPart}${nextPort}${g.rest ?? ''}${nextHash}`;
  }
  return trimmed;
}

/** Render a full outbound JSON (sing-box style) for a discovered address. */
export function toOutboundJson(config: ParsedConfig, ip: string, port?: number): string {
  const outbound: Record<string, unknown> = {
    type: config.protocol,
    tag: `ez-${ip.replace(/[.:]/g, '-')}`,
    server: ip,
    server_port: port ?? config.port,
  };
  if (config.security === 'tls' || config.security === 'reality') {
    outbound.tls = {
      enabled: true,
      server_name: config.sni || config.address,
      insecure: false,
    };
  }
  if (config.network === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: config.path || '/',
      headers: config.hostHeader ? { Host: config.hostHeader } : undefined,
    };
  }
  return JSON.stringify(outbound, null, 2);
}

/**
 * Privacy guard: when the SNI is the user's own domain, hammering it from
 * thousands of addresses is exactly what gets a domain filtered (issue #48).
 */
export function sniRiskWarnings(config: ParsedConfig): string[] {
  const out = [...config.warnings];
  if (config.security === 'reality') {
    out.push('reality needs a dest/SNI that matches the certificate — verify before scanning');
  }
  if (config.sni && config.sni === config.address) {
    out.push(
      'SNI equals your own domain: scanning with it puts that domain at risk. ' +
        'Prefer a generic SNI or scan with sni=www.cloudflare.com and swap the address afterwards.',
    );
  }
  return out;
}

/** Fast sanity list used by `ezscan config` and the GUI form. */
export function describeConfig(config: ParsedConfig): string {
  return [
    `${config.protocol} → ${config.address}:${config.port}`,
    `security=${config.security} network=${config.network}`,
    `sni=${config.sni || '(none)'}`,
    config.network === 'ws' ? `ws path=${config.path} host=${config.hostHeader || '-'}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}
