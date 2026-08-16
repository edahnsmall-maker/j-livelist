// WhatsApp export parsing — pure functions, no Node APIs, no I/O.
//
// Single source of truth: the CLI (harvester/whatsapp.mjs) and the browser
// checker (web/check.html) both use this file, so the two can never disagree
// about what a given export means.

/* ------------------------------------------------------------------ *
 * Line shapes
 *
 * Real exports are messier than the documented format:
 *   iOS      [8/19/26, 9:14:02 AM] Ari: text
 *   iOS 24h  [19/08/2026, 21:14:02] Ari: text
 *   Android  8/19/26, 9:14 AM - Ari: text
 *   Android  19/08/2026, 21:14 - Ari: text
 * plus invisible characters WhatsApp sprinkles in: U+200E (left-to-right mark)
 * at line starts and before attachments, and U+202F (narrow no-break space)
 * before AM/PM on newer iOS.
 * ------------------------------------------------------------------ */

const INVISIBLE = /[‎‏‪-‮⁦-⁩]/g;
const DATE = String.raw`(\d{1,4}[./-]\d{1,2}[./-]\d{2,4})`;
const TIME = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap]\.?[Mm]\.?)?)`;

const IOS = new RegExp(String.raw`^\[${DATE},\s*${TIME}\]\s*([\s\S]*)$`);
const ANDROID = new RegExp(String.raw`^${DATE},\s*${TIME}\s+-\s+([\s\S]*)$`);

// "Author: body" — non-greedy and length-capped so a colon inside the message
// ("Time: 7:30pm") isn't mistaken for the author separator.
const AUTHORED = /^([^:\n]{1,60}?):\s([\s\S]*)$/;

const ATTACHMENT = [
  /<attached:\s*([^>]+)>/i,                                        // iOS
  /^([\w .()-]+\.(?:jpg|jpeg|png|webp|gif|pdf|mp4|opus|m4a))\s*\(file attached\)/i, // Android
];

const MEDIA_OMITTED =
  /(?:^|\s)(?:<Media omitted>|(?:image|video|sticker|audio|document|GIF|Contact card) omitted)/i;
const EDITED = /<This message was edited>\s*$/;
const DELETED = /^(?:This message was deleted|You deleted this message|null)\.?$/i;

/**
 * Split an export into records. Every line starting with a timestamp begins a
 * new record; anything else continues the previous one.
 *
 * The distinction that matters: a timestamped line WITHOUT an "Author:" prefix
 * is a system event ("Yael added Moshe", "Ari changed the group description",
 * the encryption notice). Treating those as continuation text silently welds
 * them onto the end of the previous message and corrupts it.
 */
export function parseExport(text) {
  const raw = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n');

  const records = [];
  const unparsed = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(INVISIBLE, '');
    const m = IOS.exec(line) || ANDROID.exec(line);

    if (m) {
      if (current) records.push(current);
      const [, date, time, rest] = m;
      const authored = AUTHORED.exec(rest);
      current = authored
        ? { kind: 'message', date, time, author: authored[1].trim(), lines: [authored[2]] }
        : { kind: 'system', date, time, author: null, lines: [rest] };
      continue;
    }

    if (current) current.lines.push(line);
    else if (line.trim()) unparsed.push(line); // header junk before the first timestamp
  }
  if (current) records.push(current);

  const dayFirst = detectDayFirst(records);
  const messages = [];
  const systemEvents = [];

  for (const rec of records) {
    const body = rec.lines.join('\n').trim();
    const common = {
      author: rec.author,
      date: rec.date,
      time: rec.time,
      isoDate: toIsoDate(rec.date, dayFirst),
    };

    if (rec.kind === 'system') {
      systemEvents.push({ ...common, text: body });
      continue;
    }

    const attachments = [];
    let text = body;
    for (const re of ATTACHMENT) {
      const hit = re.exec(text);
      if (hit) {
        attachments.push(hit[1].trim());
        // Drop the marker from the text. The filename is plumbing, not content —
        // it is noise in the UI and a distraction in the model's input.
        text = text.replace(hit[0], '').trim();
      }
    }

    messages.push({
      ...common,
      text: text.replace(EDITED, '').trim(),
      attachments,
      mediaOmitted: MEDIA_OMITTED.test(body),
      edited: EDITED.test(body),
      deleted: DELETED.test(body),
    });
  }

  return { messages, systemEvents, unparsed, meta: { dayFirst, totalRecords: records.length } };
}

/**
 * Day-first (19/08/2026) or month-first (8/19/26)?
 * Decided from the whole file: if any first component exceeds 12 it can only be
 * a day. Ambiguous files default to month-first, which is right for a US export.
 */
function detectDayFirst(records) {
  for (const rec of records) {
    const first = Number(rec.date.split(/[./-]/)[0]);
    if (first > 12) return true;
  }
  return false;
}

export function toIsoDate(d, dayFirst = false) {
  const parts = d.split(/[./-]/).map(Number);
  if (parts.some(Number.isNaN)) return null;
  let year, month, day;
  if (parts[0] > 31) [year, month, day] = parts;          // 2026-08-19
  else if (dayFirst) [day, month, year] = parts;          // 19/08/2026
  else [month, day, year] = parts;                        // 8/19/26
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Event filter
 *
 * A group thread is mostly "thanks!", "is this still on?", and thumbs-up.
 * Filtering before the model runs is the difference between cents and dollars
 * per week, at almost no cost in recall: real event posts are conspicuous —
 * they carry a time, a date, or an RSVP verb.
 * ------------------------------------------------------------------ */

const EVENTISH = [
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
  /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i,
  /\b(?:rsvp|sign ?up|register|tickets?|join us|hosting|potluck|shabbat|shabbos|minyan|davening|dinner|kiddush|schmooze)\b/i,
  /\b(?:this|next)\s+(?:week|friday|saturday|sunday|monday|tuesday|wednesday|thursday|shabbat|shabbos|motzei)\b/i,
  /https?:\/\/\S+/i,
];

export function looksLikeEvent(msg) {
  if (msg.deleted) return false;
  if (msg.attachments.length) return true; // a posted flyer is the classic case
  if (msg.mediaOmitted) return false;      // exported without media; nothing to read
  if (msg.text.length < 25) return false;
  return EVENTISH.reduce((n, re) => n + (re.test(msg.text) ? 1 : 0), 0) >= 2;
}

/**
 * Parse text that was pasted rather than exported.
 *
 * Needed because a group admin can switch on WhatsApp's Advanced Chat Privacy,
 * which disables "Export chat" for every member. Copying a few posts you care
 * about still works, and that is ordinary use of the app — so this accepts
 * whatever shape that copy comes out in.
 *
 * Two shapes turn up:
 *   - Multi-select copy keeps the "[8/19/26, 9:14 AM] Ari: ..." prefixes, which
 *     is the export format, so the normal parser handles it.
 *   - Copying a single message gives bare text with no timestamp at all. Then
 *     blank-line-separated blocks are treated as separate posts.
 *
 * In block mode nothing is filtered out: the person pasted these deliberately,
 * so the curation already happened.
 */
export function parsePasted(text) {
  const parsed = parseExport(text);
  if (parsed.messages.length) return { ...parsed, mode: 'export' };

  const blocks = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);

  const messages = blocks.map((body) => ({
    author: null,
    date: null,
    time: null,
    isoDate: null,
    text: body,
    attachments: [],
    mediaOmitted: false,
    edited: false,
    deleted: false,
  }));

  return {
    messages,
    systemEvents: [],
    unparsed: [],
    meta: { dayFirst: false, totalRecords: messages.length },
    mode: 'blocks',
  };
}

/* ------------------------------------------------------------------ */

export function healthCheck({ messages, systemEvents, unparsed, meta }) {
  const dates = messages.map((m) => m.isoDate).filter(Boolean).sort();
  const byAuthor = new Map();
  for (const m of messages) byAuthor.set(m.author, (byAuthor.get(m.author) || 0) + 1);

  const candidates = messages.filter(looksLikeEvent);

  return {
    messages: messages.length,
    systemEvents: systemEvents.length,
    unparsedLines: unparsed.length,
    unparsedSample: unparsed.slice(0, 5),
    authors: byAuthor.size,
    topAuthors: [...byAuthor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    dateFormat: meta.dayFirst ? 'day-first (19/08/2026)' : 'month-first (8/19/26)',
    dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
    undatedMessages: messages.filter((m) => !m.isoDate).length,
    attachments: messages.filter((m) => m.attachments.length).length,
    mediaOmitted: messages.filter((m) => m.mediaOmitted).length,
    deleted: messages.filter((m) => m.deleted).length,
    edited: messages.filter((m) => m.edited).length,
    candidates: candidates.length,
    candidatesWithMedia: candidates.filter((m) => m.attachments.length).length,
  };
}

/** One-line verdict, shared by the CLI and the browser checker. */
export function verdict(report) {
  if (report.messages === 0)
    return { level: 'fail', text: 'No messages parsed. This export format is not one the parser knows yet.' };
  if (report.undatedMessages > report.messages * 0.05)
    return { level: 'warn', text: 'More than 5% of dates failed to parse — check the detected date format.' };
  if (report.mediaOmitted > 0 && report.attachments === 0)
    return { level: 'warn', text: 'This export has no media. Re-export with "Attach Media" to get the flyers.' };
  return { level: 'ok', text: 'This export parses cleanly.' };
}
