/* EZ Scanner GUI — vanilla JS, no build step, no CDN. */

const TOKEN = window.EZ?.token ?? '';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  config: null,
  source: { kind: 'cloudflare', limit: 5000, seed: 1337, extended: false },
  stats: null,
  scannerState: 'idle',
  network: { offline: false, message: '' },
  results: new Map(),
  logs: [],
  sessions: [],
  selected: new Set(),
  sort: 'score',
  healthyOnly: true,
  text: '',
  activeSession: null,
  totals: {},
  /** Timestamp of the last SSE message — drives the live/stale indicator. */
  lastEventAt: 0,
  /** When true the UI keeps collecting but stops repainting (user pressed pause). */
  feedPaused: false,
  pendingResults: 0,
  pendingLogs: 0,
};

/* ─────────────────────────── ui strings ─────────────────────────── */

/* The GUI is English-only: the markup carries its own text, and this table holds the
   strings that are composed in JS (counters, telemetry, reasons, empty states). */
const T = {
  live: { idle: 'idle', on: 'live', stale: 'stale', off: 'disconnected' },
  pause: 'Pause live updates',
  resume: 'Resume live updates',
  pausedState: 'paused',
  inflight: 'in flight',
  lastUpdate: (n) => `last message ${n}s ago`,
  buffered: (n) => `${n} new items buffered`,
  phase: {
    idle: 'idle',
    expanding: 'building list',
    probe: 'probe',
    speed: 'speed test',
    upload: 'upload test',
    done: 'done',
    stopped: 'stopped',
  },
  progress: (o) => `${o.phase} · ${o.done}/${o.total} (${o.pct}) · ${o.ok} answered · ${o.failed} no answer · ${o.healthy} clean`,
  detail: (o) => `${o.phase} · elapsed ${o.elapsed} · in flight ${o.inflight} · backoff ×${o.backoff}${o.msg}`,
  of: (n) => `of ${n}`,
  secs: (s) => `${s}s`,
  mins: (m, s) => `${m}m ${s}s`,
  rows: (n) => `${n} rows`,
  rowsTrunc: (n, m) => `${n} rows — showing the first ${m}`,
  foot: (n, h) => `${n} reachable · ${h} clean`,
  selected: (n, m) => `${n} of ${m} selected`,
  emptyNone: 'No results yet — start a scan.',
  emptyFiltered: 'Nothing matches this filter — clear “healthy only” or the search box.',
  logs: (n) => `${n} lines`,
  logPaused: 'updates paused',
  noSession: 'No saved session yet',
  sessionMeta: (s) => `${s.done}/${s.total} checked · ${s.healthy} clean`,
  download: 'Download session',
  remove: 'Delete session',
  ok: 'clean',
  line: { ok: 'line: ok', down: 'line: DOWN', unknown: 'line: unknown' },
  msg: {
    done: (h, t) => `done: ${h} clean of ${t}`,
    paused: 'paused',
    stopped: 'stopped by user',
    stopping: 'stopping…',
    waiting: 'waiting for the line to come back…',
    retrying: (n) => `retrying ${n} the line turned away`,
    speed: (a, b) => `speed test ${a}/${b}`,
    aborted: 'aborted',
  },
  reason: {
    noAttempt: 'nothing answered',
    successes: (a, b) => `${a} of ${b} tries answered`,
    loss: (a, b) => `loss ${a}% over ${b}%`,
    median: (a, b) => `latency ${a}ms over ${b}ms`,
    http: 'HTTP check failed',
    ws: 'WebSocket upgrade failed',
    idle: (ms) => `dropped during the ${ms}ms idle hold`,
    score: (a, b) => `score ${a} below ${b}`,
  },
  diagOk: 'ok',
  diagFail: 'fail',
  diagPreset: (preset) => `This line has a signature — scan it with --preset ${preset}`,
  diagApply: (preset) => `Apply --preset ${preset}`,
  diagApplied: (preset) => `the config now has the ${preset} preset`,
  diagNoPreset: 'No preset fits what was measured — see the reasons',
  shutting: 'The EZ Scanner server stopped — you can close this tab.',
  kind: {
    timeout: 'timeout',
    refused: 'refused',
    reset: 'reset',
    tls: 'TLS error',
    http: 'bad HTTP',
    ws: 'WebSocket',
    dns: 'DNS',
    aborted: 'aborted',
    unstable: 'unstable',
    other: 'other',
  },
};

/** Grouped thousands. */
function num(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/** Failure kinds share one spelling everywhere they surface. */
function kindLabel(kind) {
  return T.kind[kind] ?? kind;
}

/**
 * The scanner's machine-readable rejection reasons (see core/scoring.ts) rendered in the
 * UI. Anything that does not match a known shape is passed through untouched
 * rather than silently swallowed — a new reason should be visible, not invisible.
 */function reasonLabel(reason) {
  const R = T.reason;
  let m;
  if ((m = /^no successful attempt(?: \((\w+) ×(\d+)\))?$/.exec(reason))) {
    return m[1] ? `${R.noAttempt} (${kindLabel(m[1])} ×${num(m[2])})` : R.noAttempt;
  }
  if ((m = /^successes (\d+) < (\d+)$/.exec(reason))) return R.successes(num(m[1]), num(m[2]));
  if ((m = /^loss ([\d.]+)% > ([\d.]+)%$/.exec(reason))) return R.loss(num(m[1]), num(m[2]));
  if ((m = /^median ([\d.]+)ms > ([\d.]+)ms$/.exec(reason))) return R.median(num(m[1]), num(m[2]));
  if (reason === 'HTTP check failed') return R.http;
  if (reason === 'WebSocket upgrade failed') return R.ws;
  if ((m = /^connection dropped during ([\d.]+)ms idle hold$/.exec(reason))) return R.idle(num(m[1]));
  if ((m = /^score ([\d.]+) < ([\d.]+)$/.exec(reason))) return R.score(num(m[1]), num(m[2]));
  return reason;
}

/**
 * Live status messages come from the core (see core/scanner.ts) and are English. The
 * known ones get a friendly rendering; anything unrecognised is shown as-is so
 * a new message is visible rather than blank.
 */
function messageLabel(message) {
  if (!message) return '';
  const M = T.msg;
  let m;
  if ((m = /^done: (\d+) healthy of (\d+)$/.exec(message))) return M.done(num(m[1]), num(m[2]));
  if (message === 'paused') return M.paused;
  if (message === 'stopped by user') return M.stopped;
  if (message === 'stopping…') return M.stopping;
  if (message === 'waiting for the line to come back…') return M.waiting;
  if ((m = /^retrying (\d+) addresses the line turned away…$/.exec(message))) return M.retrying(num(m[1]));
  if ((m = /^speed (\d+)\/(\d+)$/.exec(message))) return M.speed(num(m[1]), num(m[2]));
  if ((m = /^aborted: (.+)$/.exec(message))) return `${M.aborted} (${m[1]})`;
  return message;
}

/* ───────────────────────────── api ───────────────────────────── */

async function api(path, body = null, method = 'POST') {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-ez-token': TOKEN },
  };
  if (body !== null) options.body = JSON.stringify(body);
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ─────────────────────────── form <-> config ─────────────────────────── */

const FIELDS = [
  ['cfg-mode', 'mode', 'str'],
  ['cfg-port', 'port', 'num'],
  ['cfg-sni', 'sni', 'str'],
  ['cfg-tries', 'tries', 'num'],
  ['cfg-min', 'minSuccesses', 'num'],
  ['cfg-timeout', 'timeoutMs', 'num'],
  ['cfg-workers', 'workers', 'num'],
  ['cfg-latency', 'maxLatencyMs', 'num'],
  ['cfg-loss', 'maxLossPct', 'num'],
  ['cfg-score', 'minScore', 'num'],
  ['cfg-requireHttp', 'requireHttp', 'bool'],
  ['cfg-requireWs', 'requireWs', 'bool'],
  ['cfg-earlyExit', 'earlyExit', 'bool'],
  ['cfg-httpPath', 'httpPath', 'str'],
  ['cfg-wsPath', 'wsPath', 'str'],
  ['cfg-stability', 'stabilityMs', 'num'],
  ['cfg-family', 'family', 'num'],
  ['cfg-measureSpeed', 'measureSpeed', 'bool'],
  ['cfg-measureUpload', 'measureUpload', 'bool'],
  ['cfg-speedBytes', 'speedBytes', 'num'],
  ['cfg-topN', 'topN', 'num'],
  ['cfg-speedSni', 'speedSni', 'str'],
  ['cfg-uploadBytes', 'uploadBytes', 'num'],
  ['cfg-speedUrl', 'speedUrl', 'str'],
  ['cfg-rate', 'rateLimitPerSec', 'num'],
  ['cfg-delay', 'minDelayMs', 'num'],
  ['cfg-backoff', 'adaptiveBackoff', 'bool'],
  ['cfg-autopause', 'autoPauseOnNetworkLoss', 'bool'],
];

function configToForm(config) {
  if (!config) return;
  for (const [id, key, kind] of FIELDS) {
    const el = $(`#${id}`);
    if (!el) continue;
    if (kind === 'bool') el.checked = Boolean(config[key]);
    else el.value = config[key] ?? '';
  }
  $('#cfg-limit').value = state.source.limit ?? 5000;
  $('#cfg-seed').value = state.source.seed ?? 1337;
  $('#cfg-extended').checked = Boolean(state.source.extended);
}

function formToConfig() {
  const config = {};
  for (const [id, key, kind] of FIELDS) {
    const el = $(`#${id}`);
    if (!el) continue;
    if (kind === 'bool') config[key] = el.checked;
    else if (kind === 'num') config[key] = Number(el.value);
    else config[key] = el.value;
  }
  return config;
}

function formToSource() {
  const kind = $('.tab.active')?.dataset.kind ?? 'cloudflare';
  const source = {
    kind,
    limit: Number($('#cfg-limit').value) || 0,
    seed: Number($('#cfg-seed').value) || 1337,
    extended: $('#cfg-extended').checked,
  };
  if (kind === 'paste') source.text = $('#cfg-paste').value;
  if (kind === 'domains') source.text = $('#cfg-domains').value;
  if (kind === 'file') source.text = $('#cfg-file').dataset.text ?? '';
  if (kind === 'config') source.config = $('#cfg-link').value;
  return source;
}

/* ───────────────────────────── results ───────────────────────────── */

function resultKey(r) {
  return `${r.ip}:${r.port}`;
}

function visibleResults() {
  const list = [...state.results.values()];
  const filtered = list.filter((r) => {
    if (state.healthyOnly && !r.healthy) return false;
    if (state.text && !(`${r.ip}:${r.port} ${r.colo} ${r.sni}`.toLowerCase().includes(state.text))) return false;
    return true;
  });
  const sorters = {
    score: (a, b) => b.score - a.score || a.medianLatency - b.medianLatency,
    latency: (a, b) => (a.medianLatency || 1e9) - (b.medianLatency || 1e9),
    down: (a, b) => (b.downMbps || 0) - (a.downMbps || 0),
    up: (a, b) => (b.upMbps || 0) - (a.upMbps || 0),
    loss: (a, b) => a.lossPct - b.lossPct,
    ip: (a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }),
  };
  return filtered.sort(sorters[state.sort] ?? sorters.score);
}

const MAX_ROWS = 500;
const REPORT_TOP = 25;

/* ─────────────────────── theme (OpenUI tokens) ─────────────────────── */

function effectiveTheme() {
  if (document.documentElement.dataset.theme) return document.documentElement.dataset.theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function paintThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const btn = $('#btn-theme');
  if (!btn) return;
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  // The button is icon-only now, so swap the glyph instead of its text.
  const use = btn.querySelector('use');
  if (use) use.setAttribute('href', dark ? '#i-sun' : '#i-moon');
}

function setTheme(next, persist = true) {
  document.documentElement.dataset.theme = next;
  if (persist) {
    try {
      localStorage.setItem('ez-theme', next);
    } catch {
      /* private mode — ignore */
    }
  }
  paintThemeButton();
  refreshReport();
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem('ez-theme');
  } catch {
    saved = null;
  }
  setTheme(saved === 'dark' || saved === 'light' ? saved : effectiveTheme(), false);
}

/** One value cell for the yes/no columns: an icon, plus a text label for screen readers. */
function yesNo(value, label) {
  if (value == null) return '<span class="meta">—</span>';
  const icon = value ? 'i-check' : 'i-x';
  const tone = value ? 'good' : 'bad';
  return `<svg class="i ${tone}" role="img" aria-label="${escapeHtml(label)}" focusable="false"><use href="#${icon}" /></svg>`;
}

function renderResults() {
  const rows = visibleResults();
  const body = $('#results-body');
  const slice = rows.slice(0, MAX_ROWS);
  const frag = document.createDocumentFragment();
  for (const r of slice) {
    const tr = document.createElement('tr');
    tr.className = r.healthy ? '' : 'not-healthy';
    const checked = state.selected.has(resultKey(r)) ? 'checked' : '';
    const latencyClass = !r.medianLatency ? '' : r.medianLatency < 300 ? 'good' : r.medianLatency < 800 ? 'mid' : 'bad';
    const lossClass = r.lossPct === 0 ? 'good' : r.lossPct <= 50 ? 'mid' : 'bad';
    const status = r.healthy
      ? `<span class="status ok"><svg class="i" aria-hidden="true"><use href="#i-check" /></svg>${T.ok}</span>`
      : `<span class="status bad"><svg class="i" aria-hidden="true"><use href="#i-x" /></svg></span><span class="status reason" title="${escapeHtml((r.reasons ?? []).join(' / '))}">${escapeHtml(reasonLabel(r.reasons?.[0] ?? '')) || '—'}</span>`;
    tr.innerHTML = `
      <td class="c"><input type="checkbox" data-key="${escapeHtml(resultKey(r))}" ${checked} /></td>
      <td class="ip">${escapeHtml(r.ip)}</td>
      <td>${num(r.port)}</td>
      <td class="${latencyClass}">${r.medianLatency ? `${num(r.medianLatency)}ms` : '—'}</td>
      <td class="${lossClass}">${num(r.lossPct)}%</td>
      <td>${r.downMbps ? `${num(r.downMbps)}M` : '—'}</td>
      <td>${r.upMbps ? `${num(r.upMbps)}M` : '—'}</td>
      <td>${num(r.score)}</td>
      <td>${r.httpStatus || '—'}</td>
      <td>${yesNo(r.wsOk, T.ok)}</td>
      <td>${yesNo(r.stable, T.ok)}</td>
      <td>${escapeHtml(r.colo || '—')}</td>
      <td>${status}</td>`;
    frag.appendChild(tr);
  }
  body.replaceChildren(frag);
  $('#bulk-count').textContent = T.selected(num(state.selected.size), num(rows.length));
  $('#results-note').textContent =
    rows.length > MAX_ROWS ? T.rowsTrunc(num(rows.length), num(MAX_ROWS)) : T.rows(num(rows.length));

  // Which column the table is ordered by, for assistive tech.
  const ascending = new Set(['latency', 'loss', 'ip']);
  for (const th of $$('th[data-sort]')) {
    if (th.dataset.sort === state.sort) th.setAttribute('aria-sort', ascending.has(state.sort) ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }

  // Empty states say WHICH empty this is — a filter that hides everything is not
  // the same thing as a scan that found nothing.
  const empty = $('#results-empty');
  if (empty) {
    empty.classList.toggle('hidden', rows.length > 0);
    $('#results-empty-text').textContent =
      state.results.size > 0 ? T.emptyFiltered : T.emptyNone;
  }

  // Server-side totals: the client-side list may be truncated for large scans.
  const reachable = state.totals.results ?? state.results.size;
  const healthy = state.totals.healthy ?? [...state.results.values()].filter((r) => r.healthy).length;
  $('#foot-summary').textContent = T.foot(num(reachable), num(healthy));
}

/* ───────────────────────────── rendering ───────────────────────────── */

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return T.secs(num(s));
  return T.mins(num(Math.floor(s / 60)), num(s % 60));
}

/**
 * Countdown as `m:ss`, digit by digit so the leading zero survives localisation.
 * The long form would wrap onto a second line inside a KPI card.
 */
function fmtClock(ms) {
  if (!ms || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  return `${num(Math.floor(total / 60))}:${num(Math.floor((total % 60) / 10))}${num(total % 10)}`;
}

/**
 * Share of the whole, or a dash while the total is still unknown. The Persian percent
 * sign is used in Persian so the number and its unit never get reordered by bidi.
 */
function share(part, total, digits = 0) {
  if (!total) return '—';
  const value = (part / total) * 100;
  return `${dec(value, digits)}%`;
}

/** Fixed-precision number in the UI locale (used for the backoff multiplier). */
function dec(value, digits) {
  return Number(value.toFixed(digits)).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * The freshness contract: telemetry is only labelled live while messages are actually
 * arriving. "Paused", "disconnected" and "stale" are visibly different states, and the
 * tooltip always says when the last message arrived.
 */
function paintLive() {
  const el = $('#live-pill');
  const txt = $('#live-text');
  if (!el || !txt) return;
  const running =
    state.scannerState === 'running' ||
    ['expanding', 'probe', 'speed', 'upload'].includes(state.stats?.phase ?? '');
  const age = state.lastEventAt ? Date.now() - state.lastEventAt : null;
  let tone = '';
  let label = T.live.idle;
  if (running && !sseOpen) {
    tone = 'off';
    label = T.live.off;
  } else if (running && age !== null && age < 5000) {
    tone = 'on';
    label = T.live.on;
  } else if (running) {
    tone = 'stale';
    label = T.live.stale;
  }
  el.className = `live ${tone}`.trim();
  txt.textContent = label;
  const notes = [];
  if (age !== null) notes.push(T.lastUpdate(num(Math.round(age / 1000))));
  const buffered = state.pendingResults + state.pendingLogs;
  if (state.feedPaused && buffered) notes.push(T.buffered(num(buffered)));
  el.title = notes.join(' · ');
}

/** Pause/resume is a real switch with a pressed state, not a hidden throttle. */
function paintFeedButton() {
  const btn = $('#btn-live-pause');
  if (!btn) return;
  btn.textContent = state.feedPaused ? T.resume : T.pause;
  btn.setAttribute('aria-pressed', String(state.feedPaused));
}

function renderStats() {
  const st = state.stats;
  if (!st) return;
  const pct = st.total ? Math.min(100, (st.done / st.total) * 100) : 0;
  $('#bar-main').style.width = `${pct}%`;
  const bar = $('#bar-main-wrap');
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.setAttribute('aria-valuetext', `${num(Math.round(pct))}% — ${num(st.done)}/${num(st.total)}`);

  // The full outcome summary lives on the bar as a tooltip; the line under it stays on
  // operational detail so it never repeats the KPI strip.
  bar.title = [
    T.progress({
      phase: T.phase[st.phase] ?? st.phase,
      done: num(st.done),
      total: num(st.total),
      pct: share(st.done, st.total, 1),
      ok: num(st.ok),
      failed: num(st.failed),
      healthy: num(st.healthy),
    }),
    st.message ? messageLabel(st.message) : '',
  ]
    .filter(Boolean)
    .join('\n');
  $('#stat-line').textContent = T.detail({
    phase: T.phase[st.phase] ?? st.phase,
    elapsed: fmtDuration(st.elapsedMs),
    inflight: num(st.inflight),
    backoff: dec(st.backoffFactor ?? 1, 2),
    msg: st.message ? ` · ${messageLabel(st.message)}` : '',
  });

  $('#kpi-checked').textContent = num(st.done);
  $('#kpi-total').textContent = T.of(num(st.total));
  $('#kpi-ok').textContent = num(st.ok);
  $('#kpi-ok-pct').textContent = share(st.ok, st.total);
  $('#kpi-failed').textContent = num(st.failed);
  $('#kpi-fail-pct').textContent = share(st.failed, st.total);
  $('#kpi-healthy').textContent = num(st.healthy);
  $('#kpi-healthy-pct').textContent = share(st.healthy, st.total);
  $('#kpi-rate').textContent = num(Math.round(st.rate ?? 0));
  const settled = st.phase === 'done' || st.phase === 'stopped';
  const eta = settled || !st.total ? null : st.etaMs;
  $('#kpi-eta').textContent = eta ? fmtClock(eta) : '—';
  $('#kpi-eta').title = eta ? fmtDuration(eta) : '';
  // Only the short fact here — the KPI sub-line must never wrap to three lines.
  $('#kpi-inflight').textContent = `${num(st.inflight)} ${T.inflight}`;

  // Why addresses fail is the first thing a red scan needs to show.
  const chips = $('#fail-chips');
  if (chips) {
    const kinds = Object.entries(st.failuresByKind ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    chips.replaceChildren(
      ...kinds.map(([kind, count]) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.append(document.createTextNode(kindLabel(kind)));
        const b = document.createElement('b');
        b.textContent = num(count);
        chip.append(b);
        chip.title = `${kind}: ${count}`;
        return chip;
      }),
    );
  }

  const badge = $('#badge-state');
  badge.textContent = st.paused ? T.pausedState : T.phase[st.phase] ?? state.scannerState;
  badge.className = `pill ${st.paused || state.scannerState === 'offline' ? 'warn' : state.scannerState === 'running' ? 'ok' : 'ghost'}`;
  const net = $('#badge-network');
  net.textContent = state.network.offline ? T.line.down : T.line.ok;
  net.className = `pill ${state.network.offline ? 'bad' : 'ok'}`;
  $('#offline-banner').classList.toggle('hidden', !state.network.offline);
  paintLive();
}

function renderLogs() {
  const filter = $('#log-filter').value;
  const list = state.logs.filter((l) => (filter === 'all' ? true : filter === 'warn' ? l.level !== 'info' : l.level === 'error'));
  const el = $('#log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  el.innerHTML = list
    .slice(-300)
    .map((l) => {
      const time = new Date(l.at).toLocaleTimeString();
      return `<div class="${l.level}">[${time}] ${escapeHtml(l.text)}</div>`;
    })
    .join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
  const count = $('#log-count');
  if (count) count.textContent = `${T.logs(num(list.length))}${state.feedPaused ? ` · ${T.logPaused}` : ''}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Icon-only control that always carries a label for screen readers and a tooltip. */
function iconButton(icon, label, data) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  Object.assign(btn.dataset, data);
  btn.innerHTML = `<svg class="i" aria-hidden="true"><use href="#${icon}" /></svg>`;
  return btn;
}

function renderSessions() {
  const ul = $('#session-list');
  if (!ul) return;
  ul.replaceChildren();
  if (!state.sessions.length) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.textContent = T.noSession;
    ul.append(li);
    return;
  }
  for (const s of state.sessions) {
    const li = document.createElement('li');
    li.className = state.activeSession === s.id ? 'active' : '';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'session';
    radio.value = s.id;
    radio.checked = state.activeSession === s.id;
    radio.setAttribute('aria-label', s.label);

    const box = document.createElement('div');
    box.style.flex = '1';
    const name = document.createElement('div');
    name.textContent = s.label;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${T.sessionMeta(s)} · ${new Date(s.updatedAt).toLocaleString('en-US')}`;
    box.append(name, meta);

    li.append(radio, box, iconButton('i-download', T.download, { act: 'download', id: s.id }), iconButton('i-trash', T.remove, { act: 'delete', id: s.id }));
    ul.append(li);
  }
}

/* ───────────────────────────── events ───────────────────────────── */

function mergeResults(list) {
  for (const r of list) state.results.set(resultKey(r), r);
}

let sseOpen = false;

/** Every message counts as a heartbeat: freshness is measured, never assumed. */
function noteActivity() {
  state.lastEventAt = Date.now();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    sseOpen = true;
    paintLive();
  };
  es.addEventListener('hello', (e) => {
    const data = JSON.parse(e.data);
    state.stats = data.stats;
    state.scannerState = data.state;
    noteActivity();
    renderStats();
  });
  es.addEventListener('progress', (e) => {
    state.stats = JSON.parse(e.data);
    noteActivity();
    if (!state.feedPaused) renderStats();
  });
  es.addEventListener('state', (e) => {
    const data = JSON.parse(e.data);
    state.scannerState = data.state;
    state.stats = data.stats;
    noteActivity();
    renderStats();
    if (data.state === 'running') ensureReport(); // a scan started: the dashboard is now worth its bundle
  });
  es.addEventListener('results', (e) => {
    const batch = JSON.parse(e.data);
    mergeResults(batch);
    noteActivity();
    // Paused means "keep collecting, stop repainting" — nothing is dropped, and
    // the pill reports how much is waiting.
    if (state.feedPaused) {
      state.pendingResults += batch.length;
      paintLive();
      return;
    }
    scheduleRender();
  });
  es.addEventListener('logs', (e) => {
    const batch = JSON.parse(e.data);
    state.logs.push(...batch);
    if (state.logs.length > 1000) state.logs = state.logs.slice(-600);
    noteActivity();
    if (state.feedPaused) {
      state.pendingLogs += batch.length;
      paintLive();
      return;
    }
    renderLogs();
  });
  es.addEventListener('network', (e) => {
    state.network = JSON.parse(e.data);
    noteActivity();
    renderStats();
  });
  es.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    toast(data.summary, 6000);
    refreshState();
    refreshReport(); // the dashboard reflects the finished scan
  });
  es.onerror = () => {
    // EventSource retries on its own; say so on screen instead of pretending to be live.
    sseOpen = es.readyState === EventSource.OPEN;
    paintLive();
  };
}

/**
 * Standard tablist behaviour: click to select, arrow keys to move, roving tabindex,
 * aria-selected kept in sync. Used by the address-source tabs and the dock.
 */
function tablist(selector, onChange) {
  const tabs = $$(selector);
  if (!tabs.length) return;
  function activate(target, focus = false) {
    for (const tab of tabs) {
      const on = tab === target;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    if (focus) target.focus();
    onChange(target);
  }
  tabs.forEach((tab, i) => {
    tab.tabIndex = tab.classList.contains('active') ? 0 : -1;
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      const step =
        e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      activate(tabs[(i + step + tabs.length) % tabs.length], true);
    });
  });
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    renderResults();
  }, 250);
}

async function refreshState() {
  const data = await api('/api/state?limit=5000', null, 'GET');
  state.config = data.config;
  state.source = data.source;
  state.stats = data.stats;
  state.scannerState = data.state;
  state.network = data.network ?? state.network;
  state.results = new Map(data.results.map((r) => [resultKey(r), r]));
  state.totals = data.totals ?? state.totals;
  state.logs = data.logs ?? [];
  state.sessions = data.sessions ?? [];
  configToForm(state.config);
  renderStats();
  renderLogs();
  renderSessions();
  renderResults();
}

/* ───────────────────────────── actions ───────────────────────────── */

async function startScan(mode = 'fresh', extra = {}) {
  try {
    const payload = { mode, config: formToConfig(), source: formToSource(), ...extra };
    if (mode === 'fresh') state.results.clear();
    const res = await api('/api/scan/start', payload);
    if (res.warnings?.length) {
      $('#config-warnings').textContent = res.warnings.join(' | ');
      toast(res.warnings[0], 7000);
    } else {
      $('#config-warnings').textContent = '';
    }
    if (mode === 'targets') state.results.clear();
    state.selected.clear();
    renderResults();
    state.scannerState = res.state;
    renderStats();
  } catch (err) {
    toast(err.message, 5000);
  }
}

function selectedKeys() {
  return [...state.selected];
}

async function copyText(text, note) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(note ?? `${text.length} chars copied`);
}

async function downloadExport(format) {
  const body = {
    format,
    keys: selectedKeys(),
    healthyOnly: state.healthyOnly,
    template: $('#export-template').value,
    labelPrefix: $('#export-prefix').value,
    hidePort: false,
  };
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ez-token': TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error ?? 'export failed', 5000);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? `ez-scanner.${format}`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`${format} exported`);
}

async function inlineExport(format) {
  const res = await api('/api/export/inline', {
    format,
    keys: selectedKeys(),
    healthyOnly: state.healthyOnly,
    template: $('#export-template').value,
    labelPrefix: $('#export-prefix').value,
  });
  $('#export-note').textContent = `${res.count} rows → ${res.filename}`;
  return res.binary ? atob(res.text) : res.text;
}

/* ─────────────────────── OpenUI report tab ─────────────────────── */

function reportUrl() {
  const params = new URLSearchParams({ embed: '1', theme: effectiveTheme(), top: String(REPORT_TOP) });
  return `/report.html?${params}`;
}

let reportMounted = false;

/** True once a scan has something to show — including an all-red one, where the
 *  failure breakdown is the whole point of the report. */
function hasScanData() {
  return (state.stats?.done ?? 0) > 0 || (state.totals.results ?? state.results.size) > 0;
}

/** The renderer bundle is ~3.5 MB, so it is only fetched when it has something to show. */
function mountReport() {
  const frame = $('#report-frame');
  if (!frame || reportMounted) return;
  reportMounted = true;
  frame.src = reportUrl();
  $('#btn-report-mount')?.classList.add('hidden');
}

/** Mounts the report only when there is data worth rendering. */
function ensureReport() {
  if (!reportMounted && hasScanData()) mountReport();
}

/** Puts the current scan state on screen (mounting first if needed). */
function refreshReport() {
  if (!reportMounted) {
    ensureReport();
    return;
  }
  const frame = $('#report-frame');
  if (frame) frame.src = reportUrl();
}

function watchReport() {
  $('#btn-report-mount').addEventListener('click', mountReport);
  const mount = $('#report-mount');
  if (!('IntersectionObserver' in window)) {
    ensureReport();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      ensureReport();
    },
    { rootMargin: '320px' },
  );
  observer.observe(mount);
}

async function copyReport() {
  const res = await fetch(`/api/report/openui?top=${REPORT_TOP}&download=1`);
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 200));
  await copyText(text, 'OpenUI Lang code copied');
}

function downloadReport() {
  const a = document.createElement('a');
  a.href = `/api/report/openui?top=${REPORT_TOP}&download=1`;
  a.download = 'ez-scanner-report.openui.md';
  a.click();
}

function openReport() {
  window.open(`/report.html?theme=${effectiveTheme()}&top=${REPORT_TOP}`, '_blank');
}

/* ───────────────────────────── wiring ───────────────────────────── */

function wire() {
  $('#btn-theme').addEventListener('click', () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));
  $('#btn-report-refresh').addEventListener('click', () => refreshReport());
  $('#btn-report-open').addEventListener('click', openReport);
  $('#btn-report-copy').addEventListener('click', () => copyReport().catch((err) => toast(err.message, 5000)));
  $('#btn-report-download').addEventListener('click', downloadReport);

  tablist('.tabs .tab', (tab) => {
    for (const block of $$('.src-block')) block.classList.add('hidden');
    $(`#src-${tab.dataset.kind}`)?.classList.remove('hidden');
  });

  tablist('.dock-tab', (tab) => {
    for (const panel of $$('[data-dock-panel]')) {
      panel.classList.toggle('hidden', panel.dataset.dockPanel !== tab.dataset.dock);
    }
    // The dashboard is only mounted once its tab is opened or it has data to show.
    if (tab.dataset.dock === 'report') ensureReport();
    if (tab.dataset.dock === 'log') renderLogs();
  });

  $('#btn-live-pause').addEventListener('click', () => {
    state.feedPaused = !state.feedPaused;
    if (!state.feedPaused) {
      state.pendingResults = 0;
      state.pendingLogs = 0;
      renderStats();
      renderLogs();
    }
    paintFeedButton();
    paintLive();
  });

  /**
   * Applies a preset to the config form. Shared by the preset buttons and by the doctor's
   * recommendation, which is the same action one click away from the measurement that produced it.
   */
  async function applyPreset(name) {
    const res = await api('/api/preset', { name });
    state.config = res.config;
    configToForm(res.config);
    for (const b of $$('.presets button')) b.classList.toggle('active', b.dataset.preset === name);
    if (res.warnings?.length) {
      $('#config-warnings').textContent = res.warnings.join(' | ');
      toast(res.warnings[0], 7000);
    }
    return res;
  }

  for (const btn of $$('.presets button')) {
    btn.addEventListener('click', () => {
      void applyPreset(btn.dataset.preset).catch((err) => toast(err.message));
    });
  }

  $('#cfg-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    $('#cfg-file').dataset.text = text;
    $('#file-info').textContent = `${file.name} · ${text.split(/\r?\n/).filter(Boolean).length} lines`;
  });

  $('#btn-preview').addEventListener('click', async () => {
    try {
      const res = await api('/api/source/preview', { source: formToSource() });
      $('#preview-out').textContent = `${res.count} addresses · ranges ${res.ranges} · domains ${res.resolved}${res.errors.length ? ` · ${res.errors.length} invalid` : ''}`;
    } catch (err) {
      $('#preview-out').textContent = err.message;
    }
  });

  $('#btn-parse-config').addEventListener('click', async () => {
    try {
      const res = await api('/api/config/parse', { config: $('#cfg-link').value });
      $('#config-parse-out').textContent = `${res.description}\n${res.warnings.join('\n')}`;
    } catch (err) {
      $('#config-parse-out').textContent = err.message;
    }
  });

  $('#btn-apply-config').addEventListener('click', async () => {
    try {
      const res = await api('/api/config/parse', { config: $('#cfg-link').value });
      $('#cfg-sni').value = res.parsed.sni ?? '';
      $('#cfg-port').value = res.parsed.port ?? 443;
      if (res.parsed.network === 'ws') $('#cfg-wsPath').value = res.parsed.path || '/';
      $('#config-parse-out').textContent = `${res.description}\n${res.warnings.join('\n')}`;
      toast('SNI / port applied');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-scan-config-domain').addEventListener('click', async () => {
    try {
      const res = await api('/api/config/parse', { config: $('#cfg-link').value });
      $('#cfg-sni').value = res.parsed.sni ?? '';
      $('#cfg-port').value = res.parsed.port ?? 443;
      const cfg = formToConfig();
      const src = { kind: 'domains', text: res.parsed.address, limit: 0, seed: 1 };
      state.results.clear();
      const started = await api('/api/scan/start', { mode: 'fresh', config: cfg, source: src, label: `config ${res.parsed.address}` });
      state.scannerState = started.state;
      toast(`scanning ${res.parsed.address}`);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-start').addEventListener('click', () => startScan('fresh'));
  $('#btn-pause').addEventListener('click', async () => {
    state.scannerState = (await api('/api/scan/pause')).state;
    renderStats();
  });
  $('#btn-resume').addEventListener('click', async () => {
    state.scannerState = (await api('/api/scan/resume')).state;
    renderStats();
  });
  $('#btn-stop').addEventListener('click', async () => {
    await api('/api/scan/stop');
    toast('stopping…');
  });
  $('#btn-save').addEventListener('click', async () => {
    const res = await api('/api/scan/save');
    state.sessions = res.sessions;
    renderSessions();
    toast('session saved');
  });

  $('#filter-healthy').addEventListener('change', (e) => {
    state.healthyOnly = e.target.checked;
    renderResults();
  });
  $('#filter-text').addEventListener('input', (e) => {
    state.text = e.target.value.trim().toLowerCase();
    renderResults();
  });
  $('#filter-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderResults();
  });
  $('#btn-refresh').addEventListener('click', () => refreshState().catch((err) => toast(err.message)));
  for (const th of $$('th[data-sort]')) {
    th.addEventListener('click', () => {
      state.sort = th.dataset.sort;
      $('#filter-sort').value = th.dataset.sort;
      renderResults();
    });
  }

  $('#results-body').addEventListener('change', (e) => {
    const key = e.target.dataset?.key;
    if (!key) return;
    if (e.target.checked) state.selected.add(key);
    else state.selected.delete(key);
    $('#bulk-count').textContent = `${state.selected.size} / ${visibleResults().length}`;
  });
  $('#results-body').addEventListener('dblclick', async (e) => {
    const tr = e.target.closest('tr');
    const ip = tr?.children[1]?.textContent;
    const port = tr?.children[2]?.textContent;
    if (ip) await copyText(`${ip}:${port}`, `${ip}:${port} copied`);
  });
  $('#check-all').addEventListener('change', (e) => {
    if (e.target.checked) for (const r of visibleResults().slice(0, MAX_ROWS)) state.selected.add(resultKey(r));
    else state.selected.clear();
    renderResults();
  });
  $('#btn-select-all').addEventListener('click', () => {
    for (const r of visibleResults()) state.selected.add(resultKey(r));
    renderResults();
  });
  $('#btn-select-none').addEventListener('click', () => {
    state.selected.clear();
    renderResults();
  });

  $('#btn-copy-ip').addEventListener('click', async () => {
    const keys = selectedKeys();
    const rows = keys.length ? keys : visibleResults().map(resultKey);
    await copyText(rows.join('\n'), `${rows.length} lines copied`);
  });
  $('#btn-copy-json').addEventListener('click', async () => {
    const keys = new Set(selectedKeys());
    const rows = visibleResults().filter((r) => !keys.size || keys.has(resultKey(r)));
    await copyText(JSON.stringify(rows, null, 2), `${rows.length} rows copied`);
  });
  $('#btn-retest-speed').addEventListener('click', async () => {
    const res = await api('/api/retest', { keys: selectedKeys(), mode: 'speed' });
    toast(`${res.updated} addresses re-tested`);
  });
  $('#btn-retest-probe').addEventListener('click', async () => {
    const res = await api('/api/retest', { keys: selectedKeys(), mode: 'probe' });
    toast(`${res.updated} addresses re-probed`);
  });
  $('#btn-rescan').addEventListener('click', async () => {
    const keys = selectedKeys();
    const list = keys.length ? keys : visibleResults().map(resultKey);
    if (!list.length) {
      toast('select some rows first');
      return;
    }
    await startScan('targets', { targets: list, label: `rescan ${list.length}` });
  });

  for (const [id, format] of [
    ['#btn-export-csv', 'csv'],
    ['#btn-export-xlsx', 'xlsx'],
    ['#btn-export-json', 'json'],
    ['#btn-export-txt', 'txt'],
    ['#btn-export-hosts', 'hosts'],
  ]) {
    $(id).addEventListener('click', () => downloadExport(format).catch((err) => toast(err.message)));
  }
  $('#btn-build-links').addEventListener('click', async () => {
    try {
      const text = await inlineExport('links');
      $('#export-note').textContent = `${text.split('\n').filter(Boolean).length} configs built — see the copy/download buttons`;
      await copyText(text, 'configs copied');
    } catch (err) {
      toast(err.message, 6000);
    }
  });
  $('#btn-copy-links').addEventListener('click', async () => {
    try {
      await copyText(await inlineExport('links'), 'configs copied');
    } catch (err) {
      toast(err.message, 6000);
    }
  });
  $('#btn-download-links').addEventListener('click', () => downloadExport('links').catch((err) => toast(err.message)));

  $('#btn-load-session').addEventListener('click', async () => {
    const id = state.activeSession;
    if (!id) {
      toast('select a session first');
      return;
    }
    await startScan('resume', { resumeId: id });
  });
  $('#session-list').addEventListener('click', async (e) => {
    // Clicks land on the icon inside the button, so resolve the button first.
    const btn = e.target.closest('button[data-act]');
    const act = btn?.dataset.act;
    const id = btn?.dataset.id;
    if (!id) return;
    if (act === 'delete') {
      const res = await api('/api/sessions/delete', { id });
      state.sessions = res.sessions;
      renderSessions();
      return;
    }
    if (act === 'download') {
      const res = await fetch('/api/sessions/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ez-token': TOKEN },
        body: JSON.stringify({ id }),
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${id.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
  });
  $('#session-list').addEventListener('change', (e) => {
    if (e.target.name === 'session') {
      state.activeSession = e.target.value;
      renderSessions();
    }
  });
  $('#session-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await api('/api/sessions/import', { raw: text });
      state.sessions = res.sessions;
      renderSessions();
      toast('session imported');
    } catch (err) {
      toast(err.message, 6000);
    }
  });

  $('#btn-doctor').addEventListener('click', async () => {
    $('#doctor-out').textContent = '…';
    try {
      const res = await api('/api/doctor');
      // The recommendation goes first: it is the one line a GUI user should be able to act on
      // without reading the checks above it.
      const recommended = res.report.recommendation;
      // A measurement with reasons and no preset is the doctor saying "this is not a parameter to
      // lower": worth the same banner, without a command that would not help.
      const verdict = recommended?.preset
        ? `<div class="warn-note"><b>${escapeHtml(T.diagPreset(recommended.preset))}</b>\n   → ${escapeHtml((recommended.reasons ?? []).join('\n   '))}\n   <button type="button" data-diag-preset="${escapeHtml(recommended.preset)}">${escapeHtml(T.diagApply(recommended.preset))}</button></div>`
        : recommended?.reasons?.length
          ? `<div class="warn-note"><b>${escapeHtml(T.diagNoPreset)}</b>\n   → ${escapeHtml(recommended.reasons.join('\n   '))}</div>`
          : '';
      $('#doctor-out').innerHTML =
        verdict +
        res.report.checks
          .map(
            (c) =>
              `<div class="${c.ok ? 'ok' : 'error'}"><b>${c.ok ? T.diagOk : T.diagFail}</b> ${escapeHtml(c.name)} — ${escapeHtml(c.detail)}${c.hint ? `\n   → ${escapeHtml(c.hint)}` : ''}</div>`,
          )
          .join('');
      toast(res.report.summary, 7000);
    } catch (err) {
      $('#doctor-out').textContent = err.message;
    }
  });

  // The recommendation is the one line of the report worth acting on, so it carries the action:
  // applying the preset the doctor just measured, through the same path the preset buttons use.
  $('#doctor-out').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-diag-preset]');
    if (!btn) return;
    const name = btn.dataset.diagPreset;
    void applyPreset(name)
      .then(() => toast(T.diagApplied(name)))
      .catch((err) => toast(err.message));
  });

  $('#log-filter').addEventListener('change', renderLogs);
  $('#btn-clear-log').addEventListener('click', () => {
    state.logs = [];
    renderLogs();
  });
  $('#btn-shutdown').addEventListener('click', async () => {
    await api('/api/shutdown');
    document.body.innerHTML = `<main class="main" style="max-width:560px;margin:12vh auto"><section class="panel"><p>${escapeHtml(T.shutting)}</p></section></main>`;
  });
}

async function main() {
  initTheme();
  wire();
  watchReport();
  paintFeedButton();
  $('#results-loading')?.classList.remove('hidden');
  try {
    await refreshState();
  } catch (err) {
    toast(err.message, 6000);
  }
  $('#results-loading')?.classList.add('hidden');
  ensureReport(); // a resumed session (or a finished scan) already has data
  paintLive();
  setInterval(paintLive, 1000);
  window.addEventListener('focus', paintLive);
  connectEvents();
}

main();
