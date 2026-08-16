// Assemble whatever we actually have into the single file the web app reads.
//
// Precedence: harvested events if a harvest has run, otherwise the labeled
// sample set. The output always carries `isSample` so the UI can say so out
// loud — a demo that quietly looks like live data is how a POC misleads the
// person it is supposed to inform.

import { readFile, writeFile } from 'node:fs/promises';

async function readJson(relPath) {
  try {
    return JSON.parse(await readFile(new URL(relPath, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

const taxonomy = await readJson('../data/taxonomy.json');
const harvested = await readJson('../data/events.harvested.json');
const whatsapp = await readJson('../data/whatsapp.json');
const submitted = await readJson('../data/events.submitted.json');
const seed = await readJson('../data/events.seed.json');

const NEIGHBORHOOD = new Map(taxonomy.neighborhoods.map((n) => [n.key, n]));

/** Give every event the shape the UI expects, filling geo from the taxonomy. */
function normalize(ev, { isSample }) {
  const hood = NEIGHBORHOOD.get(ev.neighborhood) || null;
  return {
    id: ev.id,
    title: ev.title,
    host: ev.host || null,
    start: ev.start,
    end: ev.end || null,
    venue: ev.venue || null,
    neighborhood: ev.neighborhood || null,
    neighborhoodLabel: hood?.label || 'Location unknown',
    region: hood?.region || null,
    lat: hood?.lat ?? null,
    lon: hood?.lon ?? null,
    types: ev.types || [],
    ageMin: ev.ageMin ?? null,
    ageMax: ev.ageMax ?? null,
    singlesOriented: !!ev.singlesOriented,
    observance: ev.observance ?? null,
    kosher: ev.kosher ?? null,
    shomerShabbat: ev.shomerShabbat ?? null,
    mixedGender: ev.mixedGender ?? null,
    prayer: ev.prayer ?? null,
    beginnerFriendly: ev.beginnerFriendly ?? null,
    free: ev.free ?? null,
    costMin: ev.costMin ?? null,
    costMax: ev.costMax ?? null,
    description: ev.description || '',
    url: ev.url || null,
    sourceId: ev.sourceId || 'seed',
    seenIn: ev.seenIn || (ev.sourceId ? [ev.sourceId] : []),
    confidence: ev.confidence ?? null,
    needsReview: !!ev.needsReview,
    isSample,
  };
}

const events = [];
let isSample = false;

if (harvested?.events?.length) {
  events.push(...harvested.events.map((e) => normalize(e, { isSample: false })));
} else if (seed?.events?.length) {
  isSample = true;
  events.push(...seed.events.map((e) => normalize(e, { isSample: true })));
}

// Submitted events join the pool. They carry the submitter's own answers to the
// facet questions, which is better data than anything we can infer.
for (const ev of submitted?.events || []) {
  events.push(normalize(ev, { isSample: false }));
  isSample = false;
}

// WhatsApp records that made it through extraction join the same pool, flagged
// low-confidence so the UI can show where they came from.
for (const rec of whatsapp?.records || []) {
  const x = rec.extracted;
  if (!x || x.isEvent === false || !x.startLocal) continue;
  events.push(
    normalize(
      {
        id: `wa-${Buffer.from(`${x.title}${x.startLocal}`).toString('base64url').slice(0, 10)}`,
        ...x,
        start: `${x.startLocal}:00-07:00`,
        end: x.endLocal ? `${x.endLocal}:00-07:00` : null,
        sourceId: 'whatsapp-la-events',
        confidence: x.confidence ?? 0.5,
        needsReview: (x.confidence ?? 0) < 0.8 || (x.uncertain?.length ?? 0) > 0,
      },
      { isSample: false },
    ),
  );
}

events.sort((a, b) => String(a.start).localeCompare(String(b.start)));

const payload = {
  generatedAt: new Date().toISOString(),
  isSample,
  counts: {
    total: events.length,
    needsReview: events.filter((e) => e.needsReview).length,
    free: events.filter((e) => e.free).length,
  },
  taxonomy,
  events,
};

await writeFile(new URL('../web/data.json', import.meta.url), JSON.stringify(payload, null, 2));
console.log(
  `wrote web/data.json — ${events.length} events${isSample ? ' (SAMPLE DATA: run npm run harvest for real events)' : ''}`,
);
