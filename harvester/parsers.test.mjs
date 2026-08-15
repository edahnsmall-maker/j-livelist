import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIcs, parseJsonLd, parseTribe } from './adapters.mjs';
import { classify } from './classify.mjs';
import { icsToIso, eventId } from './lib.mjs';
import { estimateFlyerCost } from './enrich.mjs';

test('ICS: unfolds wrapped lines and resolves TZID to a real offset', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Kabbalat Shabbat and dinner for young',
    '  professionals',
    'DTSTART;TZID=America/Los_Angeles:20260821T183000',
    'DTEND;TZID=America/Los_Angeles:20260821T220000',
    'LOCATION:Sinai Temple\\, Westwood',
    'DESCRIPTION:Service then dinner.\\nKosher catered.',
    'CATEGORIES:Young Adults,Shabbat',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const [ev] = parseIcs(ics);
  assert.equal(ev.title, 'Kabbalat Shabbat and dinner for young professionals');
  assert.equal(ev.start, '2026-08-21T18:30:00-07:00'); // PDT, not PST
  assert.equal(ev.venue, 'Sinai Temple, Westwood');
  assert.match(ev.description, /Kosher catered/);
  assert.deepEqual(ev.rawCategories, ['Young Adults', 'Shabbat']);
});

test('ICS: handles UTC and date-only forms', () => {
  assert.equal(icsToIso('20260822T020000Z'), '2026-08-22T02:00:00.000Z');
  assert.equal(icsToIso('20260821', 'America/Los_Angeles'), '2026-08-21T00:00:00-07:00');
});

test('ICS: a winter date gets PST, not PDT', () => {
  assert.equal(icsToIso('20260115T190000', 'America/Los_Angeles'), '2026-01-15T19:00:00-08:00');
});

test('JSON-LD: finds events nested in @graph and reads offers', () => {
  const html = `<html><script type="application/ld+json">
    {"@graph":[{"@type":"Event","name":"Torah on Tap","startDate":"2026-09-02T19:30:00-07:00",
     "location":{"name":"Bar","address":{"addressLocality":"Los Feliz"}},
     "offers":[{"price":"0"},{"price":"18"}],"description":"<p>Rabbi and a text.</p>"}]}
  </script></html>`;
  const [ev] = parseJsonLd(html);
  assert.equal(ev.title, 'Torah on Tap');
  assert.equal(ev.venue, 'Bar, Los Feliz');
  assert.deepEqual(ev.offers, { min: 0, max: 18 });
  assert.equal(ev.description, 'Rabbi and a text.');
});

test('JSON-LD: malformed blocks are skipped, not fatal', () => {
  const html = `<script type="application/ld+json">{oops</script>
    <script type="application/ld+json">{"@type":"Event","name":"OK","startDate":"2026-09-02"}</script>`;
  assert.equal(parseJsonLd(html).length, 1);
});

test('Events Calendar REST payload maps to our shape', () => {
  const [ev] = parseTribe({
    events: [
      {
        title: 'Volunteer Night',
        utc_start_date: '2026-09-03 01:00:00',
        venue: { venue: 'Warehouse', city: 'Culver City' },
        categories: [{ name: 'Volunteer' }],
        description: '<p>Packing meals.</p>',
      },
    ],
  });
  assert.equal(ev.title, 'Volunteer Night');
  assert.equal(ev.start, '2026-09-03T01:00:00Z');
  assert.equal(ev.venue, 'Warehouse, Culver City');
  assert.deepEqual(ev.rawCategories, ['Volunteer']);
});

test('classifier: host prior sets observance, event text overrides gender', () => {
  const out = classify(
    {
      title: "Women's Challah Bake",
      description: 'Join us in Venice. $18 per person. Women only.',
      venue: 'Chabad of Venice',
      start: '2026-08-27T19:00:00-07:00',
    },
    { host: 'Chabad of Venice', sourceId: 'chabad-la' },
  );
  assert.equal(out.observance, 5);        // from the host prior
  assert.equal(out.kosher, true);
  assert.equal(out.mixedGender, false);   // reinforced by "Women only"
  assert.equal(out.neighborhood, 'venice');
  assert.equal(out.costMin, 18);
  assert.ok(out.types.includes('food'));
});

test('classifier: refuses to guess observance for an unknown host', () => {
  const out = classify(
    { title: 'Shabbat dinner', description: 'Come hang.', venue: 'A house', start: '2026-08-21T19:00:00-07:00' },
    { host: 'Some New Collective', sourceId: 'whatsapp-la-events' },
  );
  assert.equal(out.observance, null);
  assert.equal(out.needsReview, true); // Friday + unknown observance is the risky case
  assert.ok(out.missing.includes('observance (no host prior matched)'));
});

test('classifier: reads explicit age ranges and singles orientation', () => {
  const out = classify(
    { title: 'Singles hike', description: 'Ages 25-40. Singles welcome.', venue: 'Temescal Canyon', start: '2026-08-23T08:30:00-07:00' },
    { host: 'JConnect LA', sourceId: 'x' },
  );
  assert.equal(out.ageMin, 25);
  assert.equal(out.ageMax, 40);
  assert.equal(out.singlesOriented, true);
  assert.equal(out.neighborhood, 'santa-monica');
});

test('dedupe key ignores punctuation and filler words', () => {
  const a = { title: 'The Shabbat Dinner!', start: '2026-08-21T19:00:00-07:00', neighborhood: 'venice' };
  const b = { title: 'Shabbat Dinner', start: '2026-08-21T20:30:00-07:00', neighborhood: 'Venice' };
  assert.equal(eventId(a), eventId(b));
});

test('flyer cost estimate is bounded and scales linearly', () => {
  const opus = estimateFlyerCost({ flyersPerWeek: 100 });
  assert.equal(opus.model, 'claude-opus-5');
  assert.ok(opus.perFlyer > 0 && opus.perFlyer < 0.10, `unexpected per-flyer cost ${opus.perFlyer}`);
  assert.ok(Math.abs(opus.perWeek - opus.perFlyer * 100) < 0.01);

  const haiku = estimateFlyerCost({ flyersPerWeek: 100, model: 'claude-haiku-4-5' });
  assert.ok(haiku.perFlyer < opus.perFlyer);
});
