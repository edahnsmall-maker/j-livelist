// WhatsApp ingest CLI. The parsing itself lives in ../shared/wa-parse.mjs so the
// browser checker (web/check.html) runs identical logic.
//
// Why the export and not a bot: libraries like Baileys and whatsapp-web.js log
// into WhatsApp's multi-device protocol and read a group automatically. They
// violate Meta's terms, and the current failure mode is the phone number getting
// banned — including numbers that ran quietly for years. "Export chat" is a
// first-party feature: a member exports a thread they already belong to.
//
// Nothing here uploads anything. Parsing and the health check are entirely
// local; only `--llm` makes a network call, and then only for messages that
// survive the event filter.
//
//   node harvester/whatsapp.mjs chat.txt --check
//   node harvester/whatsapp.mjs chat.txt --media ./media --llm --out data/whatsapp.json

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseExport, looksLikeEvent, healthCheck, verdict } from '../shared/wa-parse.mjs';

export { parseExport, looksLikeEvent, healthCheck, toIsoDate, verdict } from '../shared/wa-parse.mjs';

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

  const v = verdict(report);
  console.log(`\n  ${v.level.toUpperCase()} — ${v.text}\n`);
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node harvester/whatsapp.mjs <export.txt> [--check] [--media DIR] [--llm] [--out FILE]');
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

  const mediaFiles = mediaDir ? await readdir(mediaDir).catch(() => []) : [];
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
