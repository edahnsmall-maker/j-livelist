// Shared utilities. Deliberately dependency-free so the core harvest path runs
// with a bare `node harvester/harvest.mjs` and no install step.

import { createHash } from 'node:crypto';

export const UA = 'j-livelist/0.1 (LA Jewish events aggregator; contact: you@example.com)';

/**
 * Fetch with a timeout and a polite user agent.
 * Returns { ok, status, text, error } and never throws, so one dead source
 * cannot take down a harvest run.
 */
export async function get(url, { timeoutMs = 20000, accept = '*/*' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get('content-type') || '' };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stable ID for an event. Two harvests of the same event must produce the same
 * id, and two different sources describing the same real-world event should
 * collide here so dedupe works. Hence: date + normalized title, not the URL.
 */
export function eventId(ev) {
  const day = (ev.start || '').slice(0, 10);
  const key = `${day}|${normalizeTitle(ev.title)}|${(ev.neighborhood || '').toLowerCase()}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

export function normalizeTitle(s = '') {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/&/g, 'and')
    .replace(/\b(the|a|an|at|for|with|our|annual)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Miles between two lat/lon points. Haversine, good enough for a city. */
export function distanceMiles(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * The offset string (e.g. "-07:00") for an instant in a named zone.
 * Needed because ICS feeds give wall-clock times plus a TZID, and LA switches
 * between -08:00 and -07:00 halfway through the High Holiday season.
 */
export function zoneOffset(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const part = fmt.formatToParts(date).find((p) => p.type === 'timeZoneName');
  const m = /GMT([+-]\d{2}:\d{2})?/.exec(part?.value || '');
  return m?.[1] || '+00:00';
}

/**
 * Convert an ICS date-time to an ISO string with a real offset.
 * Handles the three forms feeds actually emit: floating local, UTC (trailing Z),
 * and TZID-qualified.
 */
export function icsToIso(value, tzid, defaultZone = 'America/Los_Angeles') {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh = '00', mi = '00', ss = '00', z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss)).toISOString();

  const zone = tzid || defaultZone;
  // Guess the offset from the naive instant, then re-check: near a DST boundary
  // the first guess can be an hour off, and the second pass settles it.
  let guess = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss));
  for (let i = 0; i < 2; i++) {
    const off = zoneOffset(guess, zone);
    const sign = off.startsWith('-') ? 1 : -1;
    const [oh, om] = off.slice(1).split(':').map(Number);
    guess = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) + sign * (oh * 60 + om) * 60000);
  }
  const off = zoneOffset(guess, zone);
  return `${y}-${mo}-${d}T${hh}:${mi}:${ss}${off}`;
}

export function stripHtml(s = '') {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(s = '', n = 400) {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
