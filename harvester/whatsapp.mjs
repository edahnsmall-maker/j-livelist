// WhatsApp ingest, via WhatsApp's own "Export chat" feature.
//
// This is the deliberate architectural choice of the whole project. There are
// libraries that log into WhatsApp's multi-device protocol and read a group
// automatically; they violate Meta's terms and the current consequence is the
// phone number getting banned — including numbers that ran quietly for years.
// Staking the founder's personal number, which is presumably the one in the
// group, on that is a bad trade.
//
// "Export chat" is a first-party feature: a member opens the thread, exports it,
// and gets a .txt (plus media if they choose). That is a person exercising their
// own access to a thread they belong to, and it produces the same data. It costs
// one manual step a week.
//
// Usage:
//   node harvester/whatsapp.mjs chat.txt --out data/whatsapp.json
//   node harvester/whatsapp.mjs chat.txt --media ./media --llm --out data/whatsapp.json

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// iOS:     [8/21/26, 7:30:12 PM] Ari: text
// Android: 8/21/26, 7:30 PM - Ari: text
const IOS = /^‎?\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*([\d:]+\s*(?:AM|PM)?)\]\s*([^:]+?):\s*([\s\S]*)$/i;
const ANDROID = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*([\d:]+\s*(?:AM|PM)?)\s*-\s*([^:]+?):\s*([\s\S]*)$/i;

const ATTACHMENT = [
  /<attached:\s*([^>]+)>/i,               // iOS
  /^‎?([\w-]+\.(?:jpg|jpeg|png|webp|pdf))\s*\(file attached\)/i, // Android
];
const MEDIA_OMITTED = /‎?(image|video|sticker|document) omitted/i;

/** Split an export into individual messages, joining wrapped continuation lines. */
export function parseExport(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const messages = [];
  let current = null;

  for (const line of lines) {
    const m = IOS.exec(line) || ANDROID.exec(line);
    if (m) {
      if (current) messages.push(current);
      const [, date, time, author, body] = m;
      current = { date, time, author: author.trim(), lines: [body], attachments: [] };
    } else if (current) {
      current.lines.push(line);
    }
    // Lines before the first timestamp are export headers and encryption
    // notices; dropping them is correct.
  }
  if (current) messages.push(current);

  return messages.map((msg) => {
    const body = msg.lines.join('\n').trim();
    const attachments = [];
    for (const re of ATTACHMENT) {
      const hit = re.exec(body);
      if (hit) attachments.push(hit[1].trim());
    }
    return {
      author: msg.author,
      date: msg.date,
      time: msg.time,
      text: body,
      attachments,
      mediaOmitted: MEDIA_OMITTED.test(body),
    };
  });
}

// Cheap prefilter. A group thread is mostly "thanks!", "is this still on?", and
// thumbs-up. Sending all of it to a model is the difference between a few cents
// a week and a few dollars, and the recall cost is near zero because real event
// posts are conspicuous: they carry a time, a date, or an RSVP verb.
const EVENTISH = [
  /\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\b/i,
  /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?\b/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i,
  /\b(rsvp|sign ?up|register|tickets?|join us|come ?through|hosting|potluck|shabbat|shabbos|minyan|hosting)\b/i,
  /\b(this|next)\s+(week|friday|saturday|sunday|monday|tuesday|wednesday|thursday|shabbat|shabbos)\b/i,
  /(https?:\/\/\S+)/i,
];

export function looksLikeEvent(msg) {
  if (msg.attachments.length) return true; // a posted flyer is the classic case
  if (msg.mediaOmitted) return false;      // nothing left to read
  const t = msg.text;
  if (t.length < 25) return false;
  const score = EVENTISH.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  return score >= 2;
}

/** Normalize the export's M/D/YY into an ISO date so the LLM can anchor "Friday". */
function toIsoDate(d) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(d);
  if (!m) return null;
  let [, mm, dd, yy] = m;
  const year = yy.length === 2 ? 2000 + +yy : +yy;
  return `${year}-${String(+mm).padStart(2, '0')}-${String(+dd).padStart(2, '0')}`;
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node harvester/whatsapp.mjs <export.txt> [--media DIR] [--llm] [--out FILE]');
    process.exit(1);
  }
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  const mediaDir = flag('--media');
  const outFile = flag('--out') || 'data/whatsapp.json';
  const useLlm = rest.includes('--llm');

  const messages = parseExport(await readFile(file, 'utf8'));
  const candidates = messages.filter(looksLikeEvent);

  console.log(`parsed   ${messages.length} messages`);
  console.log(`candidates ${candidates.length} look like event announcements`);
  console.log(`  with attachments: ${candidates.filter((c) => c.attachments.length).length}`);
  console.log(`skipped  ${messages.length - candidates.length} (chatter, reactions, media-omitted)`);

  let mediaFiles = [];
  if (mediaDir) {
    mediaFiles = await readdir(mediaDir).catch(() => []);
  }

  const records = [];
  for (const msg of candidates) {
    const record = {
      author: msg.author,
      postedOn: toIsoDate(msg.date),
      text: msg.text,
      attachments: msg.attachments,
      resolvedMedia: msg.attachments
        .map((a) => mediaFiles.find((f) => f === a || f.includes(path.parse(a).name)))
        .filter(Boolean)
        .map((f) => path.join(mediaDir, f)),
      extracted: null,
    };

    if (useLlm) {
      const { readFlyer, enrichEvent } = await import('./enrich.mjs');
      try {
        record.extracted = record.resolvedMedia.length
          ? await readFlyer(record.resolvedMedia[0], {
              referenceDate: record.postedOn,
              caption: msg.text,
            })
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
  console.log(`\nwrote ${kept.length} records to ${outFile}`);
  if (!useLlm) console.log('(re-run with --llm and ANTHROPIC_API_KEY set to extract structured fields)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
