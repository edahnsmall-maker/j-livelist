// Fold submitted events into the dataset.
//
// Drop each submission JSON (the payload the submit form produces) into
// data/submissions/ as its own .json file, then:
//
//   npm run ingest && npm run build:data
//
// Submissions are trusted more than a scrape and less than a verified source:
// the person filling the form usually knows the answers, but nothing stops them
// mistyping a date. Anything they marked "not sure" stays null and gets flagged,
// which is the same rule the classifier follows.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { classify } from './classify.mjs';
import { eventId } from './lib.mjs';

const DIR = new URL('../data/submissions/', import.meta.url);
const OUT = new URL('../data/events.submitted.json', import.meta.url);

const FACETS = ['kosher', 'shomerShabbat', 'mixedGender', 'prayer', 'beginnerFriendly'];

/** LA offset for a given local date — PDT or PST, whichever applies that day. */
function laOffset(isoLocal) {
  const probe = new Date(`${isoLocal}:00Z`);
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')?.value;
  return /GMT([+-]\d{2}:\d{2})/.exec(name || '')?.[1] || '-08:00';
}

export function normalizeSubmission(sub) {
  if (!sub || sub._schema !== 'j-livelist/submission@1') return null;

  const start = sub.startLocal ? `${sub.startLocal}:00${laOffset(sub.startLocal)}` : null;

  // Run the text through the same classifier the scrapers use, so a submission
  // that skipped the optional fields still gets types and a neighborhood guess.
  const guessed = classify(
    {
      title: sub.title || '',
      description: sub.description || '',
      venue: '',
      start: start || new Date().toISOString(),
    },
    { host: sub.host || '', sourceId: 'submission' },
  );

  // Facets come from the submitter alone — never from the classifier.
  //
  // For a scraped event a host prior is the best signal available, so guessing
  // is reasonable. Here it isn't: a human was asked this exact question and
  // said "not sure". Letting an inference answer on their behalf is how a wrong
  // label gets in, and a wrong label is the one failure worth avoiding. So an
  // unanswered facet stays null and the event goes to review.
  const facets = Object.fromEntries(
    FACETS.map((k) => [k, sub[k] === true || sub[k] === false ? sub[k] : null]),
  );

  const event = {
    ...guessed,
    title: sub.title || guessed.title || 'Untitled',
    host: sub.host || null,
    start,
    end: null,
    venue: null,
    neighborhood: sub.neighborhood || guessed.neighborhood,
    url: sub.url || null,
    description: sub.description || '',
    ageMin: sub.ageMin ?? guessed.ageMin,
    ageMax: sub.ageMax ?? guessed.ageMax,
    free: sub.free ?? guessed.free,
    costMin: sub.costMin ?? guessed.costMin,
    costMax: sub.costMax ?? guessed.costMax,
    observance: sub.observance ?? guessed.observance,
    ...facets,
    sourceId: 'submission',
    submitter: sub.submitter || null,
    flyers: sub.flyers || [],
  };

  // Observance is treated differently from the facets. It is a soft descriptor
  // ("the general feel"), and the host prior is the same signal we rely on for
  // every scraped event — so refusing to apply it here would be inconsistent.
  // But an inference must never pass as a confirmation: the value is kept and
  // the event is still flagged, with `missing` saying which it was.
  const observanceConfirmed = typeof sub.observance === 'number';
  const unanswered = FACETS.filter((k) => event[k] == null);

  event.id = eventId(event);
  // Confidence tracks what the submitter actually answered, not what we inferred.
  event.confidence = Number(
    (0.55 + 0.08 * (FACETS.length - unanswered.length) + (observanceConfirmed ? 0.05 : 0)).toFixed(2),
  );
  event.needsReview = unanswered.length > 0 || !observanceConfirmed || !start;
  event.missing = [
    ...unanswered.map((k) => `${k} (submitter said "not sure")`),
    ...(observanceConfirmed
      ? []
      : [event.observance == null ? 'observance' : 'observance (inferred from host, not confirmed)']),
    ...(start ? [] : ['start time']),
  ];

  return event;
}

async function main() {
  await mkdir(DIR, { recursive: true });
  const names = (await readdir(DIR)).filter((n) => n.endsWith('.json'));

  const events = [];
  const rejected = [];
  for (const name of names) {
    let raw;
    try {
      raw = JSON.parse(await readFile(new URL(name, DIR), 'utf8'));
    } catch (err) {
      rejected.push({ name, why: `not valid JSON — ${err.message}` });
      continue;
    }
    // A file may hold one submission or an array of them.
    for (const sub of [].concat(raw)) {
      const ev = normalizeSubmission(sub);
      if (ev) events.push(ev);
      else rejected.push({ name, why: 'missing or unrecognized _schema' });
    }
  }

  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), events }, null, 2));

  console.log(`ingested ${events.length} submission(s) from ${names.length} file(s)`);
  const review = events.filter((e) => e.needsReview);
  if (review.length) {
    console.log(`${review.length} need review:`);
    for (const e of review) console.log(`  ${e.title} — ${e.missing.join(', ')}`);
  }
  for (const r of rejected) console.log(`  skipped ${r.name}: ${r.why}`);
  console.log('wrote data/events.submitted.json — run `npm run build:data` to fold it in');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
