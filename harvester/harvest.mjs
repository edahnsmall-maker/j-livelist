// Harvest CLI.
//
//   node harvester/harvest.mjs --probe    test every candidate endpoint, report what is real
//   node harvester/harvest.mjs            harvest, classify, dedupe, write data/events.harvested.json
//   node harvester/harvest.mjs --dry-run  same, but print instead of writing
//
// --probe is the important one. Every URL in data/sources.json is a hypothesis
// until it has been hit from a machine with open network access; run the probe
// first and let it tell you which of them are real.

import { readFile, writeFile } from 'node:fs/promises';
import { runAdapter } from './adapters.mjs';
import { classify } from './classify.mjs';
import { eventId, normalizeTitle } from './lib.mjs';

const SOURCES = new URL('../data/sources.json', import.meta.url);

async function probe() {
  const { sources } = JSON.parse(await readFile(SOURCES, 'utf8'));
  const results = [];

  for (const src of sources) {
    if (!src.probe?.length) {
      results.push({ id: src.id, method: src.method, status: 'skipped', detail: 'no probe URL (manual/partner source)' });
      continue;
    }
    for (const url of src.probe) {
      const { events, calendar, note } = await runAdapter(src.method, url);
      const count = events.length || calendar?.length || 0;
      results.push({
        id: src.id,
        method: src.method,
        url,
        status: count > 0 ? 'live' : note === 'ok' ? 'empty' : 'failed',
        count,
        detail: note,
        sample: events[0]?.title || calendar?.[0]?.title || null,
      });
      process.stdout.write(
        `${count > 0 ? '  live' : note === 'ok' ? ' empty' : 'FAILED'}  ${String(count).padStart(4)}  ${src.id}  ${note}\n`,
      );
    }
  }

  const live = results.filter((r) => r.status === 'live');
  console.log(`\n${live.length}/${results.length} endpoints returned parseable events.`);
  console.log('Update the `verified` flags in data/sources.json from this run.');
  await writeFile('data/probe-report.json', JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log('Full report: data/probe-report.json');
  return results;
}

/**
 * Merge duplicates. The same Shabbat dinner routinely appears on the shul's
 * calendar, the Federation aggregate, and the WhatsApp thread. Keep the record
 * with the highest confidence and remember every source that saw it — an event
 * three sources agree on is more trustworthy than one that appeared once.
 */
function dedupe(events) {
  const byKey = new Map();
  for (const ev of events) {
    const key = eventId(ev);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...ev, id: key, seenIn: [ev.sourceId] });
      continue;
    }
    existing.seenIn = [...new Set([...existing.seenIn, ev.sourceId])];
    if ((ev.confidence || 0) > (existing.confidence || 0)) {
      byKey.set(key, { ...ev, id: key, seenIn: existing.seenIn });
    }
    // Fill any field the winning record left null from the runner-up.
    const winner = byKey.get(key);
    for (const [k, v] of Object.entries(ev)) {
      if (winner[k] == null && v != null && k !== 'seenIn') winner[k] = v;
    }
  }
  return [...byKey.values()].sort((a, b) => a.start.localeCompare(b.start));
}

async function harvest({ dryRun = false } = {}) {
  const { sources } = JSON.parse(await readFile(SOURCES, 'utf8'));
  const raw = [];
  const log = [];

  for (const src of sources) {
    if (!src.probe?.length) continue;
    for (const url of src.probe) {
      const { events, note } = await runAdapter(src.method, url);
      log.push({ id: src.id, url, got: events.length, note });
      for (const ev of events) {
        raw.push(classify(ev, { host: src.name, sourceId: src.id }));
      }
    }
  }

  const now = Date.now();
  const upcoming = raw.filter((e) => {
    const t = Date.parse(e.start);
    return Number.isFinite(t) && t > now - 12 * 3600 * 1000; // keep today's earlier events
  });
  const events = dedupe(upcoming);

  const review = events.filter((e) => e.needsReview);
  console.log(`harvested ${raw.length} raw → ${upcoming.length} upcoming → ${events.length} after dedupe`);
  console.log(`${review.length} need review (low confidence or unlabeled Shabbat/weekend observance)`);
  for (const entry of log) {
    console.log(`  ${String(entry.got).padStart(4)}  ${entry.id.padEnd(24)} ${entry.note}`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    counts: { raw: raw.length, upcoming: upcoming.length, deduped: events.length, needsReview: review.length },
    sourceLog: log,
    events,
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2).slice(0, 4000));
    return payload;
  }
  await writeFile('data/events.harvested.json', JSON.stringify(payload, null, 2));
  console.log('wrote data/events.harvested.json');
  return payload;
}

const args = process.argv.slice(2);
if (args.includes('--probe')) await probe();
else await harvest({ dryRun: args.includes('--dry-run') });

export { dedupe, normalizeTitle };
