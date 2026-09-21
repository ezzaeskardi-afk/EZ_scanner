/**
 * Doctor DNS checks.
 *
 * A resolver that answers with the operator's block-page address is the one failure mode
 * that makes a working scanner look broken: every domain source then probes a host that
 * was never the real one. These tests pin the classification and the DoH response
 * parsing, so `ezscan doctor` keeps naming that cause instead of blaming the tool.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hijackReason, judgeDns, parseDohAnswers } from '../src/server/doctor.ts';

test('block-page answers are flagged, real ones are not', () => {
  for (const ip of ['10.10.34.34', '10.10.34.35', '10.10.34.36']) {
    assert.equal(hijackReason(ip), 'the operator block-page address', `${ip} is the block page`);
  }
  assert.equal(hijackReason('104.16.132.229'), null);
  assert.equal(hijackReason('1.1.1.1'), null);
  assert.equal(hijackReason('2606:4700::6810:84e5'), null, 'a public v6 answer is fine');
});

test('private, loopback and CGNAT answers are flagged for a public name', () => {
  const reason = 'a private/unroutable address';
  assert.equal(hijackReason('127.0.0.1'), reason);
  assert.equal(hijackReason('0.0.0.0'), reason);
  assert.equal(hijackReason('10.1.2.3'), reason);
  assert.equal(hijackReason('172.16.0.9'), reason);
  assert.equal(hijackReason('192.168.1.1'), reason);
  assert.equal(hijackReason('169.254.1.1'), reason);
  assert.equal(hijackReason('100.64.0.1'), reason, 'carrier-grade NAT space is not a Cloudflare edge');
  assert.equal(hijackReason('172.32.0.1'), null, '172.32/12 is public');
  assert.equal(hijackReason('100.63.0.1'), null, '100.63/10 is public');
});

test('IPv6 and malformed answers are handled', () => {
  assert.equal(hijackReason('::1'), 'a private/unroutable address');
  assert.equal(hijackReason('fd00::1'), 'a private/unroutable address');
  assert.equal(hijackReason('fe80::1'), null, 'link-local is only reachable, not a redirect target we claim');
  assert.equal(hijackReason('[2606:4700::1111]'), null, 'a bracketed answer is still judged by its address');
  assert.match(hijackReason('not-an-address') ?? '', /not an IP address/);
});

test('a resolver that answers nothing is a failure, not a silent pass', () => {
  // `defaultResolve` reports "could not resolve" by returning `[]`, so the row keyed on
  // `answers.length` never ran: a line with a dead resolver was told "DNS lookup: ok — no answer"
  // and the user went looking at the scanner while every domain source was probing nothing.
  const dead = judgeDns({
    answers: [
      { name: 'cloudflare.com', ips: [], reason: null },
      { name: 'speed.cloudflare.com', ips: [], reason: null },
    ],
    doh: null,
  });
  const lookup = dead.checks.find((check) => check.name === 'DNS lookup');
  assert.ok(lookup, 'the row is always reported');
  assert.equal(lookup.ok, false, 'no answer from any name is a failed check');
  assert.match(lookup.detail, /no answer for cloudflare\.com, speed\.cloudflare\.com/);
  assert.match(lookup.hint ?? '', /scan by IP/, 'and it says what still works');

  const thrown = judgeDns({ answers: [], doh: null, failure: 'getaddrinfo ENOTFOUND' });
  assert.equal(thrown.checks[0].ok, false);
  assert.equal(thrown.checks[0].detail, 'getaddrinfo ENOTFOUND', 'the resolver error is kept verbatim');
});

test('a resolver that answers is judged on the answer', () => {
  const poisoned = judgeDns({
    answers: [{ name: 'cloudflare.com', ips: ['10.10.34.34'], reason: 'the operator block-page address' }],
    doh: { ips: ['104.16.132.229'], via: '1.1.1.1' },
  });
  assert.equal(poisoned.checks[0].ok, false);
  assert.equal(poisoned.hijack?.answer[0], '10.10.34.34', 'and the hijack is reported for the CLI/GUI banner');
  assert.equal(poisoned.hijack?.dohVia, '1.1.1.1');

  const clean = judgeDns({
    answers: [{ name: 'cloudflare.com', ips: ['104.16.132.229'], reason: null }],
    doh: { ips: ['104.16.132.229', '104.16.133.229'], via: '8.8.8.8' },
  });
  assert.deepEqual(clean.checks.map((check) => check.ok), [true, true], 'both rows pass');
  assert.equal(clean.hijack, undefined);
});

test('DoH disagreeing with a silent resolver does not claim tampering', () => {
  // "the system resolver said nothing — the answer is being tampered with" was the old wording
  // for this case, which points the user at the wrong problem: a failing lookup is not a rewritten
  // one. The row above already failed; this one must say what DoH knows without inventing a cause.
  const judged = judgeDns({
    answers: [{ name: 'cloudflare.com', ips: [], reason: null }],
    doh: { ips: ['104.16.132.229'], via: '1.1.1.1' },
  });
  const dohRow = judged.checks.find((check) => check.name.startsWith('DNS over HTTPS'));
  assert.ok(dohRow);
  assert.equal(dohRow.ok, false);
  assert.match(dohRow.detail, /answered nothing at all/);
  assert.doesNotMatch(dohRow.detail, /tampered/);
  assert.match(dohRow.hint ?? '', /lookup itself is failing/);
});

test('DoH answers are parsed from both provider shapes', () => {
  // Cloudflare DoH (and Google's /resolve) both use the same `Answer[].data` shape, with
  // the A records typed 1 and a CNAME in front of them.
  const body = JSON.stringify({
    Status: 0,
    Answer: [
      { name: 'cloudflare.com.', type: 5, data: 'cloudflare.com.cdn.cloudflare.net.' },
      { name: 'cloudflare.com.', type: 1, data: '104.16.132.229' },
      { name: 'cloudflare.com.', type: 1, data: '104.16.133.229' },
    ],
  });
  assert.deepEqual(parseDohAnswers(body), ['104.16.132.229', '104.16.133.229']);
  assert.deepEqual(parseDohAnswers('{}'), []);
  assert.deepEqual(parseDohAnswers('not json at all'), [], 'a block page is not a DNS answer');
});
