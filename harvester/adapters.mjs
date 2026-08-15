// One adapter per harvest method. Each takes a source record from
// data/sources.json and returns { events, note } — never throws.
//
// The order here is the order of preference: ICS and the Events Calendar REST
// route give you real structured data; JSON-LD is nearly as good; everything
// after that is guesswork and should be routed through review.

import { get, icsToIso, stripHtml, truncate } from './lib.mjs';

/** RFC 5545 line unfolding: a line starting with space/tab continues the previous. */
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeIcs(s = '') {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

export function parseIcs(text) {
  const events = [];
  const blocks = unfold(text).split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const fields = {};
    for (const line of body.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const rawKey = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const [name, ...params] = rawKey.split(';');
      const tzid = params.find((p) => p.startsWith('TZID='))?.slice(5);
      const key = name.toUpperCase();
      // CATEGORIES can legitimately repeat; everything else takes first-wins.
      if (key === 'CATEGORIES') (fields.CATEGORIES ||= []).push(value);
      else if (!(key in fields)) fields[key] = { value, tzid };
    }
    const start = fields.DTSTART && icsToIso(fields.DTSTART.value, fields.DTSTART.tzid);
    if (!start) continue;
    events.push({
      title: unescapeIcs(fields.SUMMARY?.value || 'Untitled'),
      start,
      end: fields.DTEND ? icsToIso(fields.DTEND.value, fields.DTEND.tzid) : null,
      venue: unescapeIcs(fields.LOCATION?.value || ''),
      description: truncate(stripHtml(unescapeIcs(fields.DESCRIPTION?.value || ''))),
      url: fields.URL?.value || null,
      rawCategories: (fields.CATEGORIES || []).flatMap((c) => c.split(',')).map((c) => c.trim()),
    });
  }
  return events;
}

/** Pull every schema.org Event out of a page's JSON-LD blocks. */
export function parseJsonLd(html) {
  const events = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue; // Malformed JSON-LD is common in the wild; skip it quietly.
    }
    for (const node of flattenLd(data)) {
      const types = [].concat(node['@type'] || []);
      if (!types.some((t) => String(t).toLowerCase().includes('event'))) continue;
      if (!node.startDate) continue;
      const loc = node.location || {};
      events.push({
        title: node.name || 'Untitled',
        start: node.startDate,
        end: node.endDate || null,
        venue: [loc.name, loc.address?.streetAddress, loc.address?.addressLocality]
          .filter(Boolean)
          .join(', '),
        description: truncate(stripHtml(node.description || '')),
        url: node.url || null,
        image: typeof node.image === 'string' ? node.image : node.image?.url || null,
        offers: normalizeOffers(node.offers),
        rawCategories: [].concat(node.keywords || []).flatMap((k) => String(k).split(',')),
      });
    }
  }
  return events;
}

function flattenLd(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => flattenLd(n, out));
  else if (node && typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flattenLd(node['@graph'], out);
    if (node.subEvent) flattenLd(node.subEvent, out);
  }
  return out;
}

function normalizeOffers(offers) {
  const list = [].concat(offers || []).filter(Boolean);
  if (!list.length) return null;
  const prices = list.map((o) => Number(o.price)).filter((n) => Number.isFinite(n));
  if (!prices.length) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/** The Events Calendar (WordPress) REST payload. */
export function parseTribe(json) {
  const list = json?.events;
  if (!Array.isArray(list)) return [];
  return list.map((e) => ({
    title: e.title ? stripHtml(e.title) : 'Untitled',
    start: e.utc_start_date ? `${e.utc_start_date.replace(' ', 'T')}Z` : e.start_date,
    end: e.utc_end_date ? `${e.utc_end_date.replace(' ', 'T')}Z` : e.end_date || null,
    venue: [e.venue?.venue, e.venue?.address, e.venue?.city].filter(Boolean).join(', '),
    description: truncate(stripHtml(e.description || e.excerpt || '')),
    url: e.url || null,
    image: e.image?.url || null,
    offers: e.cost_details?.values?.length
      ? { min: Math.min(...e.cost_details.values.map(Number)), max: Math.max(...e.cost_details.values.map(Number)) }
      : null,
    rawCategories: [
      ...(e.categories || []).map((c) => c.name),
      ...(e.tags || []).map((t) => t.name),
    ].filter(Boolean),
  }));
}

/**
 * Hebcal is not an events source — it is the calendar skeleton. Chag dates and
 * LA candle-lighting times let the app flag a Friday event that starts after
 * candle lighting, which matters enormously to a level-4/5 user and is
 * invisible to every generic events app.
 */
export function parseHebcal(json) {
  const items = json?.items;
  if (!Array.isArray(items)) return [];
  return items.map((i) => ({
    title: i.title,
    start: i.date,
    category: i.category, // candles | havdalah | holiday | parashat | …
    hebrew: i.hebrew || null,
    memo: i.memo || null,
    yomtov: !!i.yomtov,
  }));
}

const ADAPTERS = {
  ics: async (url) => {
    const res = await get(url, { accept: 'text/calendar' });
    if (!res.ok) return { events: [], note: `HTTP ${res.status}${res.error ? ` ${res.error}` : ''}` };
    if (!res.text.includes('BEGIN:VCALENDAR')) return { events: [], note: 'not an iCalendar document' };
    return { events: parseIcs(res.text), note: 'ok' };
  },
  tribe: async (url) => {
    const res = await get(url, { accept: 'application/json' });
    if (!res.ok) return { events: [], note: `HTTP ${res.status}${res.error ? ` ${res.error}` : ''}` };
    try {
      return { events: parseTribe(JSON.parse(res.text)), note: 'ok' };
    } catch {
      return { events: [], note: 'route exists but did not return JSON' };
    }
  },
  jsonld: async (url) => {
    const res = await get(url, { accept: 'text/html' });
    if (!res.ok) return { events: [], note: `HTTP ${res.status}${res.error ? ` ${res.error}` : ''}` };
    const events = parseJsonLd(res.text);
    return { events, note: events.length ? 'ok' : 'page fetched but no schema.org Event found' };
  },
  hebcal: async (url) => {
    const res = await get(url, { accept: 'application/json' });
    if (!res.ok) return { events: [], note: `HTTP ${res.status}`, calendar: [] };
    try {
      return { events: [], calendar: parseHebcal(JSON.parse(res.text)), note: 'ok' };
    } catch {
      return { events: [], calendar: [], note: 'not JSON' };
    }
  },
};

// Eventbrite organizer pages are ordinary HTML with JSON-LD per event; only
// platform-wide *search* was withdrawn. Same adapter, different label so the
// registry stays honest about what it is doing.
ADAPTERS['eventbrite-org'] = ADAPTERS.jsonld;

export async function runAdapter(method, url) {
  const fn = ADAPTERS[method];
  if (!fn) return { events: [], note: `no adapter for method "${method}" (manual/partner source)` };
  return fn(url);
}

export const SUPPORTED_METHODS = Object.keys(ADAPTERS);
