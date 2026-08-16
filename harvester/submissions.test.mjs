import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSubmission } from './ingest-submissions.mjs';

const base = {
  _schema: 'j-livelist/submission@1',
  title: 'Rooftop Havdalah',
  host: 'Base LA',
  startLocal: '2026-09-05T20:30',
  neighborhood: 'west-hollywood',
  description: 'Short havdalah, then dessert.',
  ageMin: 22, ageMax: 38,
  free: true, costMin: 0, costMax: 0,
  observance: 3,
  kosher: true, shomerShabbat: false, mixedGender: true, prayer: true, beginnerFriendly: true,
  flyers: [], needsReview: true,
};

test('a fully answered submission is high confidence and needs no review', () => {
  const ev = normalizeSubmission(base);
  assert.equal(ev.start, '2026-09-05T20:30:00-07:00'); // PDT in September
  assert.equal(ev.needsReview, false);
  assert.ok(ev.confidence >= 0.95, `confidence was ${ev.confidence}`);
  assert.equal(ev.kosher, true);
  assert.equal(ev.shomerShabbat, false);
});

test('"not sure" facets stay null — a guess never answers for the submitter', () => {
  const ev = normalizeSubmission({ ...base, kosher: null, mixedGender: null, observance: null });
  assert.equal(ev.kosher, null);
  assert.equal(ev.mixedGender, null);
  assert.equal(ev.needsReview, true);
  assert.ok(ev.missing.some((m) => m.startsWith('kosher')));
  assert.ok(ev.confidence < 0.9);
});

test('an inferred observance is kept but never passes as confirmed', () => {
  // "Base LA" matches a host prior, so the level is still useful information —
  // it just has to be labelled as an inference rather than an answer.
  const ev = normalizeSubmission({ ...base, observance: null });
  assert.equal(ev.observance, 2, 'host prior should still apply');
  assert.equal(ev.needsReview, true);
  assert.ok(ev.missing.some((m) => m.includes('inferred from host')));
});

test('the submitter overrides the classifier, because they were there', () => {
  // "Chabad" as host would make the classifier guess level 5, separate seating.
  const ev = normalizeSubmission({
    ...base,
    host: 'Chabad of Venice',
    observance: 5,
    mixedGender: true, // the submitter says this particular event is mixed
  });
  assert.equal(ev.mixedGender, true);
  assert.equal(ev.observance, 5);
});

test('a winter submission gets PST, not PDT', () => {
  const ev = normalizeSubmission({ ...base, startLocal: '2026-01-10T19:00' });
  assert.equal(ev.start, '2026-01-10T19:00:00-08:00');
});

test('anything without the schema marker is rejected rather than guessed at', () => {
  assert.equal(normalizeSubmission({ title: 'hi' }), null);
  assert.equal(normalizeSubmission(null), null);
});
