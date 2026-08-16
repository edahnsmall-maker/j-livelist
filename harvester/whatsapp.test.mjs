import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseExport, parsePasted, looksLikeEvent, healthCheck, toIsoDate } from './whatsapp.mjs';

// A realistic iOS export. Note the invisible characters WhatsApp actually
// emits: U+200E (LRM) at line starts and before attachments, and U+202F
// (narrow no-break space) before AM/PM on newer versions.
const IOS_EXPORT = [
  '‎[8/19/26, 9:00:01 AM] ‎Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
  '[8/19/26, 9:14:02 AM] Ari Weiss: Shabbat dinner this Friday 7:30pm in Pico-Robertson',
  'RSVP by Thursday, $18 to cover food',
  'Address when you RSVP',
  '[8/19/26, 9:15:00 AM] Dana: thanks!',
  '[8/19/26, 9:16:00 AM] Dana: ‎image omitted',
  '‎[8/19/26, 10:00:00 AM] ‎Yael added Moshe Katz',
  '[8/19/26, 10:02:11 AM] Yael: ‎<attached: 00000042-PHOTO-2026-08-19-10-02-11.jpg>',
  'flyer for the hike Sunday',
  '[8/19/26, 10:30:00 AM] Moshe Katz: Time: 7:30pm sharp, please don’t be late',
  '[8/19/26, 11:00:00 AM] Ari Weiss: updated the address ‎<This message was edited>',
  '[8/19/26, 11:05:00 AM] Dana: This message was deleted',
].join('\n');

// Android, day-first dates and 24-hour time — the other common shape.
const ANDROID_EXPORT = [
  '19/08/2026, 09:14 - Messages and calls are end-to-end encrypted.',
  '19/08/2026, 09:15 - Ari Weiss: Kabbalat Shabbat Friday 18:45 at the shul, kiddush after',
  'walking distance from Pico',
  '19/08/2026, 09:20 - Dana: 👍',
  '19/08/2026, 10:02 - Yael: IMG-20260819-WA0001.jpg (file attached)',
  '19/08/2026, 10:03 - Yael: <Media omitted>',
  '19/08/2026, 10:30 - Ari Weiss changed the subject to "LA Jewish Events"',
].join('\n');

test('iOS: system messages do not corrupt the preceding message', () => {
  const { messages, systemEvents } = parseExport(IOS_EXPORT);

  // "Yael added Moshe Katz" has no "Author:" prefix. An earlier version of this
  // parser welded it onto the end of the previous message.
  const dana = messages.find((m) => m.author === 'Dana' && m.mediaOmitted);
  assert.ok(dana, 'expected the media-omitted message');
  assert.doesNotMatch(dana.text, /added Moshe/);

  assert.equal(systemEvents.length, 2); // encryption notice + the add
  assert.match(systemEvents[0].text, /end-to-end encrypted/);
  assert.match(systemEvents[1].text, /Yael added Moshe Katz/);
});

test('iOS: multi-line messages are joined, invisible characters stripped', () => {
  const { messages } = parseExport(IOS_EXPORT);
  const first = messages[0];
  assert.equal(first.author, 'Ari Weiss');
  assert.match(first.text, /RSVP by Thursday/);
  assert.match(first.text, /Address when you RSVP/);
  assert.doesNotMatch(first.text, /[‎ ]/);
});

test('iOS: a colon inside the message body is not mistaken for the author', () => {
  const { messages } = parseExport(IOS_EXPORT);
  const m = messages.find((x) => x.text.startsWith('Time:'));
  assert.equal(m.author, 'Moshe Katz');
  assert.match(m.text, /^Time: 7:30pm sharp/);
});

test('iOS: attachments, edits, deletions, and omitted media are all flagged', () => {
  const { messages } = parseExport(IOS_EXPORT);
  const withFile = messages.find((m) => m.attachments.length);
  assert.equal(withFile.attachments[0], '00000042-PHOTO-2026-08-19-10-02-11.jpg');
  assert.match(withFile.text, /flyer for the hike/);
  // The marker itself is plumbing and should not survive into the text.
  assert.doesNotMatch(withFile.text, /<attached:/);

  assert.equal(messages.filter((m) => m.mediaOmitted).length, 1);
  assert.equal(messages.filter((m) => m.edited).length, 1);
  assert.equal(messages.filter((m) => m.deleted).length, 1);

  const edited = messages.find((m) => m.edited);
  assert.doesNotMatch(edited.text, /This message was edited/);
});

test('Android: day-first dates and 24-hour times parse correctly', () => {
  const { messages, systemEvents, meta } = parseExport(ANDROID_EXPORT);
  assert.equal(meta.dayFirst, true);
  assert.equal(messages[0].isoDate, '2026-08-19'); // 19/08, not 8/19
  assert.equal(messages[0].author, 'Ari Weiss');
  assert.match(messages[0].text, /18:45/);

  assert.equal(messages.find((m) => m.attachments.length).attachments[0], 'IMG-20260819-WA0001.jpg');
  assert.equal(messages.filter((m) => m.mediaOmitted).length, 1); // <Media omitted>
  assert.ok(systemEvents.some((s) => /changed the subject/.test(s.text)));
});

test('date parsing: month-first, day-first, 2-digit years, and ISO', () => {
  assert.equal(toIsoDate('8/19/26', false), '2026-08-19');
  assert.equal(toIsoDate('19/08/2026', true), '2026-08-19');
  assert.equal(toIsoDate('2026-08-19'), '2026-08-19');
  assert.equal(toIsoDate('13/45/26', false), null); // nonsense stays null, not a wrong date
});

test('event filter keeps announcements and flyers, drops chatter', () => {
  const { messages } = parseExport(IOS_EXPORT);
  const candidates = messages.filter(looksLikeEvent);

  assert.ok(candidates.some((m) => /Shabbat dinner this Friday/.test(m.text)));
  assert.ok(candidates.some((m) => m.attachments.length));
  assert.ok(!candidates.some((m) => m.text === 'thanks!'));
  assert.ok(!candidates.some((m) => m.deleted));
  assert.ok(!candidates.some((m) => m.mediaOmitted && !m.attachments.length));
});

test('health check reports the numbers you need to trust an export', () => {
  const report = healthCheck(parseExport(IOS_EXPORT));
  assert.equal(report.unparsedLines, 0);
  assert.equal(report.undatedMessages, 0);
  assert.equal(report.dateRange[0], '2026-08-19');
  assert.equal(report.dateFormat, 'month-first (8/19/26)');
  assert.ok(report.authors >= 3);
  assert.ok(report.candidates >= 2);
  assert.equal(report.candidatesWithMedia, 1);
});

test('an unrecognized format reports zero messages rather than inventing them', () => {
  const junk = 'some random file\nwith no timestamps at all\n';
  const parsed = parseExport(junk);
  assert.equal(parsed.messages.length, 0);
  assert.equal(parsed.unparsed.length, 2);
  assert.equal(healthCheck(parsed).messages, 0);
});

test('pasted text with timestamps is treated as an export', () => {
  const parsed = parsePasted(
    '[8/19/26, 9:14:02 AM] Ari: Shabbat dinner Friday 7:30pm, RSVP by Thursday\n' +
    '[8/19/26, 9:15:00 AM] Dana: thanks!',
  );
  assert.equal(parsed.mode, 'export');
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages.filter(looksLikeEvent).length, 1);
});

test('pasted text without timestamps becomes one candidate per block', () => {
  // The case when a group has export disabled and you copy posts by hand.
  const parsed = parsePasted(
    'Shabbat dinner this Friday 7:30pm in Pico-Robertson, $18\n\n' +
    'Torah on Tap next Wednesday at a bar in Los Feliz\n\n' +
    'ok',   // too short to be a post
  );
  assert.equal(parsed.mode, 'blocks');
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].author, null);
  assert.equal(parsed.messages[0].isoDate, null);
});
