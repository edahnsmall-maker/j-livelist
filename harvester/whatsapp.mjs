// WhatsApp ingest, via WhatsApp's own "Export chat" feature.
//
// Why the export and not a bot: libraries like Baileys and whatsapp-web.js log
// into WhatsApp's multi-device protocol and read a group automatically. They
// violate Meta's terms, and the current failure mode is the phone number getting
// banned — including numbers that ran quietly for years. "Export chat" is a
// first-party feature: a member of the group exports a thread they already
// belong to. Same data, no ban risk, one manual step a week.
//
// Nothing here uploads anything. Parsing and the health check are entirely
// local; only `--llm` makes a network call, and then only for the messages that
// survive the event filter.
//
//   node harvester/whatsapp.mjs chat.txt --check
//   node harvester/whatsapp.mjs chat.txt --media ./media --llm --out data/whatsapp.json

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Line shapes
 *
 * Real exports are messier than the documented format. These are the
 * variations that actually show up:
 *   iOS      [8/19/26, 9:14:02 AM] Ari: text
 *   iOS 24h  [19/08/2026, 21:14:02] Ari: text
 *   Android  8/19/26, 9:14 AM - Ari: text
 *   Android  19/08/2026, 21:14 - Ari: text
 * plus invisible characters WhatsApp sprinkles in: U+200E (left-to-right mark)
 * at line starts and before attachments, and U+202F (narrow no-break space)
 * before AM/PM on newer iOS.
 * ------------------------------------------------------------------ */

const INVISIBLE = /[‎‏⁦-⁩]/g;
const DATE = String.raw`(\d{1,4}[./-]\d{1,2}[./-]\d{2,4})`;
const TIME = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap]\.?[Mm]\.?)?)`;

const IOS = new RegExp(String.raw`^\[${DATE},\s*${TIME}\]\s*([\s\S]*)$`);
const ANDROID = new RegExp(String.raw`^${DATE},\s*${TIME}\s+-\s+([\s\S]*)$`);

// "Author: body" — non-greedy and length-capped so a colon inside the message
// ("Time: 7:30pm") doesn't get mistaken for the author separator.
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
 * Split an export into records. Every line that starts with a timestamp begins a
 * new record; anything else continues the previous one.
 *
 * The distinction that matters: a timestamped line WITHOUT an "Author:" prefix
 * is a system event ("Yael added Moshe", "Ari changed the group description",
 * the encryption notice). Treating those as continuation text silently welds
 * them onto the end of the previous message and corrupts it — which is exactly
 * what an earlier version of this file did.
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
    for (const re of ATTACHMENT) {
      const hit = re.exec(body);
      if (hit) attachments.push(hit[1].trim());
    }

    messages.push({
      ...common,
      text: body.replace(EDITED, '').trim(),
      attachments,
      mediaOmitted: MEDIA_OMITTED.test(body),
      edited: EDITED.test(body),
      deleted: DELETED.test(body),
    });
  }

  return { messages, systemEvents, unparsed, meta: { dayFirst, totalRecords: records.length } };
}

/**
 * Is this export day-first (19/08/2026) or month-first (8/19/26)?
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
 * per week, and costs almost no recall: real event posts are conspicuous —
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

/* ------------------------------------------------------------------ *
 * Health check — run this against your real export first
 * ------------------------------------------------------------------ */

export function healthCheck({ messages, systemEvents, unparsed, meta }) {
  const dates = messages.map((m) => m.isoDate).filter(Boolean).sort();
  const byAuthor = new Map();
  for (const m of messages) byAuthor.set(m.author, (byAuthor.get(m.author) || 0) + 1);

  const candidates = messages.filter(looksLikeEvent);
  const withMedia = messages.filter((m) => m.attachments.length);
  const omitted = messages.filter((m) => m.mediaOmitted);

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
    attachments: withMedia.length,
    mediaOmitted: omitted.length,
    deleted: messages.filter((m) => m.deleted).length,
    edited: messages.filter((m) => m.edited).length,
    candidates: candidates.length,
    candidatesWithMedia: candidates.filter((m) => m.attachments.length).length,
  };
}

function printCheck(report, { mediaFound = null } = {}) {
  const ok = (b) => (b ? '  ok  ' : ' WARN ');
  console.log('\n  WhatsApp export health check');
  console.log('  ' + '-'.repeat(52));
  console.log(`${ok(report.messages > 0)} messages parsed        ${report.messages}`);
  console.log(`${ok(true)} system events           ${report.systemEvents} (joins, renames, encryption notice)`);
  console.log(`${ok(report.unparsedLines === 0)} unparsed lines          ${report.unparsedLines}`);
  console.log(`${ok(report.authors > 1)} distinct authors        ${report.authors}`);
  console.log(`${ok(!!report.dateRange)} date range              ${report.dateRange ? report.dateRange.join(' → ') : 'none'}`);
  console.log(`${ok(report.undatedMessages === 0)} unparseable dates       ${report.undatedMessages}`);
  console.log(`${ok(true)} date format detected    ${report.dateFormat}`);
  console.log(`${ok(true)} attachments referenced  ${report.attachments}`);
  console.log(`${ok(true)} media omitted           ${report.mediaOmitted}${report.mediaOmitted ? '  (exported without media)' : ''}`);
  console.log(`${ok(report.candidates > 0)} event candidates        ${report.candidates} (${report.candidatesWithMedia} with a flyer)`);

  if (mediaFound !== null) {
    console.log(`${ok(mediaFound.matched === mediaFound.referenced)} media files matched     ${mediaFound.matched}/${mediaFound.referenced}`);
  }

  if (report.unparsedLines) {
    console.log('\n  Lines before the first timestamp (usually harmless export headers):');
    for (const l of report.unparsedSample) console.log(`    ${l.slice(0, 90)}`);
  }

  console.log('\n  Top posters (a sanity check that names came through):');
  for (const [name, n] of report.topAuthors) console.log(`    ${String(n).padStart(5)}  ${name}`);

  const verdict =
    report.messages === 0
      ? 'FAILED — no messages parsed. The export format is not one this parser knows; send me the first 3 lines.'
      : report.undatedMessages > report.messages * 0.05
        ? 'PARTIAL — more than 5% of dates failed to parse. Check the date format above.'
        : report.mediaOmitted > 0 && report.attachments === 0
          ? 'OK, but exported WITHOUT media — re-export with "Attach Media" to get the flyers.'
          : 'OK — this export parses cleanly.';
  console.log(`\n  ${verdict}\n`);
  return verdict;
}

/* ------------------------------------------------------------------ */

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error(
      'usage: node harvester/whatsapp.mjs <export.txt> [--check] [--media DIR] [--llm] [--out FILE]',
    );
    process.exit(1);
  }
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  const mediaDir = flag('--media');
  const outFile = flag('--out') || 'data/whatsapp.json';
  const useLlm = rest.includes('--llm');
  const checkOnly = rest.includes('--check');

  const parsed = parseExport(await readFile(file, 'utf8'));
  const report = healthCheck(parsed);

  let mediaFiles = [];
  if (mediaDir) mediaFiles = await readdir(mediaDir).catch(() => []);

  const resolveMedia = (names) =>
    names
      .map((a) => mediaFiles.find((f) => f === a || f.includes(path.parse(a).name)))
      .filter(Boolean)
      .map((f) => path.join(mediaDir, f));

  const candidates = parsed.messages.filter(looksLikeEvent);
  const referenced = candidates.reduce((n, c) => n + c.attachments.length, 0);
  const matched = candidates.reduce((n, c) => n + resolveMedia(c.attachments).length, 0);

  printCheck(report, { mediaFound: mediaDir ? { referenced, matched } : null });

  if (checkOnly) {
    console.log('  --check only: nothing written, nothing sent anywhere.\n');
    return;
  }

  const records = [];
  for (const msg of candidates) {
    const record = {
      author: msg.author,
      postedOn: msg.isoDate,
      text: msg.text,
      attachments: msg.attachments,
      resolvedMedia: resolveMedia(msg.attachments),
      extracted: null,
    };

    if (useLlm) {
      const { readFlyer, enrichEvent } = await import('./enrich.mjs');
      try {
        record.extracted = record.resolvedMedia.length
          ? await readFlyer(record.resolvedMedia[0], { referenceDate: record.postedOn, caption: msg.text })
          : await enrichEvent(msg.text, {
              referenceDate: record.postedOn,
              context: 'Posted to a Los Angeles Jewish community WhatsApp group.',
            });
      } catch (err) {
        record.extracted = { error: String(err?.message || err) };
      }
    }
    records.push(record);
  }

  const kept = records.filter((r) => !r.extracted || r.extracted.isEvent !== false);
  await writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), records: kept }, null, 2));
  console.log(`  wrote ${kept.length} records to ${outFile}`);
  if (!useLlm) console.log('  (re-run with --llm and ANTHROPIC_API_KEY set to extract structured fields)\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
