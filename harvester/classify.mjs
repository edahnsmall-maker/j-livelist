// Turn a scraped blob of text into the filter fields the app needs.
//
// Design note: this is deliberately rules-first. Rules are free, instant,
// debuggable, and get you roughly 70% of the way. The remaining 30% — irony,
// implication, "no phones please", a flyer with the details only in the image —
// is what the LLM pass in enrich.mjs is for. Anything the rules are unsure
// about is marked needsReview rather than guessed at, because a wrong
// religiosity label is the single worst failure this product can have: it sends
// someone to an event where they feel out of place, which is the exact
// experience the app exists to prevent.

import taxonomy from '../data/taxonomy.json' with { type: 'json' };

const NEIGHBORHOODS = taxonomy.neighborhoods;

// Aliases people actually write, mapped to canonical keys.
const PLACE_HINTS = {
  'pico-robertson': ['pico-robertson', 'pico robertson', 'pico blvd', 's robertson'],
  beverlywood: ['beverlywood'],
  'hancock-park': ['hancock park', 'la brea', 'miracle mile', 'larchmont', 'tar pits'],
  'beverly-hills': ['beverly hills'],
  'west-hollywood': ['west hollywood', 'weho', 'melrose'],
  'century-city': ['century city'],
  westwood: ['westwood', 'ucla'],
  brentwood: ['brentwood'],
  'santa-monica': ['santa monica', 'temescal'],
  venice: ['venice', 'abbot kinney'],
  'marina-del-rey': ['marina del rey', 'playa'],
  'culver-city': ['culver city'],
  'mar-vista': ['mar vista', 'palms'],
  'silver-lake': ['silver lake', 'silverlake'],
  'los-feliz': ['los feliz', 'atwater'],
  'echo-park': ['echo park'],
  dtla: ['downtown', 'dtla', 'arts district'],
  'sherman-oaks': ['sherman oaks'],
  'studio-city': ['studio city'],
  'valley-village': ['valley village', 'north hollywood', 'noho'],
  encino: ['encino'],
  tarzana: ['tarzana'],
  'woodland-hills': ['woodland hills'],
  calabasas: ['calabasas', 'agoura', 'conejo'],
  pasadena: ['pasadena'],
  'long-beach': ['long beach'],
  online: ['zoom', 'online', 'virtual', 'webinar'],
};

const TYPE_HINTS = {
  'shabbat-dinner': ['shabbat dinner', 'friday night dinner', 'shabbos dinner', 'onetable', 'shabbat & chill'],
  'shabbat-services': ['kabbalat shabbat', 'friday night service', 'minyan', 'davening', 'shacharit', 'services'],
  holiday: ['rosh hashanah', 'yom kippur', 'sukkot', 'simchat torah', 'chanukah', 'hanukkah', 'purim', 'passover', 'pesach', 'seder', 'shavuot', 'tisha', 'selichot', 'tashlich', 'break fast', 'high holiday'],
  learning: ['class', 'course', 'lecture', 'learning', 'shiur', 'workshop', 'seminar'],
  'text-study': ['torah', 'talmud', 'daf yomi', 'parsha', 'mishnah', 'text study', 'beit midrash'],
  social: ['happy hour', 'party', 'mixer', 'social', 'game night', 'bar night', 'drinks'],
  singles: ['singles', 'speed dating', 'shidduch', 'matchmaking', 'meet someone'],
  professional: ['networking', 'professionals', 'career', 'entrepreneur', 'business'],
  volunteer: ['volunteer', 'tzedakah', 'chesed', 'food drive', 'packing', 'service project', 'mitzvah day'],
  outdoors: ['hike', 'hiking', 'beach', 'camping', 'picnic', 'outdoor', 'park', 'trail'],
  arts: ['concert', 'film', 'music', 'art', 'gallery', 'theater', 'screening', 'comedy'],
  food: ['cooking', 'challah bake', 'potluck', 'bbq', 'brunch', 'dinner', 'tasting', 'kiddush'],
  sports: ['basketball', 'soccer', 'yoga', 'run', 'fitness', 'softball', 'pickleball'],
  family: ['kids', 'family', 'children', 'tot', 'stroller', 'parents'],
  israel: ['israel', 'israeli', 'idf', 'aliyah', 'hebrew'],
  spiritual: ['meditation', 'mindfulness', 'kabbalah', 'spiritual', 'mussar', 'rosh chodesh', 'healing'],
};

// Host priors. The strongest single signal available: the institution is a
// better predictor of vibe than any keyword in the event copy.
const HOST_PRIORS = [
  { match: ['chabad', 'aish', 'yeshiva', 'kollel', 'young israel of', 'shaarey', 'bais '], observance: 5, kosher: true, mixedGender: false, beginnerFriendly: true },
  { match: ['pico shul', 'happy minyan'], observance: 5, kosher: true, mixedGender: false, beginnerFriendly: true },
  { match: ['modern orthodox', 'yavneh', 'beth jacob', 'young israel'], observance: 4, kosher: true, mixedGender: false },
  { match: ['conservative', 'sinai temple', 'valley beth shalom', 'adat ', 'shtibl', 'mishkon'], observance: 3, kosher: true, mixedGender: true },
  { match: ['hillel', 'base ', 'moishe house', 'onetable'], observance: 2, mixedGender: true, beginnerFriendly: true },
  { match: ['reform', 'temple israel', 'wilshire boulevard temple', 'stephen wise', 'open temple', 'nashuva', 'ikar', 'leo baeck'], observance: 2, mixedGender: true, beginnerFriendly: true },
  // Deliberately specific. Generic words like "collective", "community", or
  // "society" appear in the names of orgs at every level, and matching on them
  // produces a confident wrong label — the one outcome worth avoiding most.
  { match: ['federation', 'jconnect', 'yjp los angeles', 'tribester', 'jewish sports'], observance: 1, mixedGender: true, beginnerFriendly: true },
];

// Text that overrides the host prior, because it describes the event itself.
const OBSERVANCE_TEXT = [
  { re: /\b(mechitza|separate seating|men'?s (night|only)|women'?s (night|only|circle))\b/i, set: { mixedGender: false } },
  { re: /\b(mixed seating|egalitarian|all genders|co-?ed)\b/i, set: { mixedGender: true } },
  { re: /\b(glatt|kosher|hechsher|pareve|dairy|cholov)\b/i, set: { kosher: true } },
  { re: /\bnot kosher|non-?kosher|bring your own food\b/i, set: { kosher: false } },
  { re: /\b(shomer shabbat|shomer shabbos|no phones|phone-?free|leave your phone|no photography on shabbat|walking distance)\b/i, set: { shomerShabbat: true } },
  { re: /\b(service|davening|minyan|prayer|siddur|tefillah|kabbalat)\b/i, set: { prayer: true } },
  { re: /\b(no experience|beginner|newcomers?|first[- ]time|all levels|transliterat)\b/i, set: { beginnerFriendly: true } },
  { re: /\b(secular|cultural|non-?religious|no religious content)\b/i, set: { observance: 1 } },
];

const lc = (s) => String(s || '').toLowerCase();

function pickNeighborhood(text) {
  const hay = lc(text);
  for (const [key, hints] of Object.entries(PLACE_HINTS)) {
    if (hints.some((h) => hay.includes(h))) return key;
  }
  return null;
}

function pickTypes(text, rawCategories = []) {
  const hay = lc(`${text} ${rawCategories.join(' ')}`);
  const hits = [];
  for (const [type, hints] of Object.entries(TYPE_HINTS)) {
    if (hints.some((h) => hay.includes(h))) hits.push(type);
  }
  return hits.slice(0, 4);
}

/**
 * Age range. Explicit numbers beat phrases; phrases beat nothing.
 * Returns null when there is no signal, which is the honest answer far more
 * often than any keyword table would suggest.
 */
function pickAges(text) {
  const hay = lc(text);
  const explicit = /\b(?:ages?\s*)?(\d{2})\s*(?:-|–|to)\s*(\d{2})\b/.exec(hay);
  if (explicit) {
    const [, min, max] = explicit;
    if (+min >= 13 && +max <= 99 && +min < +max) return { ageMin: +min, ageMax: +max };
  }
  if (/\b(20s and 30s|20s\/30s|twenties and thirties)\b/.test(hay)) return { ageMin: 22, ageMax: 39 };
  if (/\byoung professionals?\b/.test(hay)) return { ageMin: 24, ageMax: 40 };
  if (/\byoung adults?\b/.test(hay)) return { ageMin: 21, ageMax: 39 };
  if (/\b(grad students?|graduate students?)\b/.test(hay)) return { ageMin: 21, ageMax: 32 };
  if (/\b(college|undergrad|students?)\b/.test(hay)) return { ageMin: 18, ageMax: 22 };
  if (/\b(families|kids|children|all ages)\b/.test(hay)) return { ageMin: 0, ageMax: 120 };
  if (/\bseniors?\b/.test(hay)) return { ageMin: 60, ageMax: 120 };
  return null;
}

function pickCost(text, offers) {
  if (offers && Number.isFinite(offers.min)) {
    return { free: offers.min === 0 && offers.max === 0, costMin: offers.min, costMax: offers.max };
  }
  const hay = lc(text);
  if (/\b(free|no charge|no cost|complimentary|donation|pay what you can|rsvp only)\b/.test(hay)) {
    return { free: true, costMin: 0, costMax: 0 };
  }
  const prices = [...hay.matchAll(/\$\s?(\d{1,4})(?:\.\d\d)?/g)].map((m) => +m[1]).filter((n) => n <= 1000);
  if (prices.length) return { free: false, costMin: Math.min(...prices), costMax: Math.max(...prices) };
  return null;
}

/**
 * Classify one raw event. `host` is passed separately because the host prior
 * carries more weight than anything in the body copy.
 */
export function classify(raw, { host = '', sourceId = 'unknown' } = {}) {
  const text = `${raw.title || ''}\n${raw.description || ''}\n${raw.venue || ''}`;
  const searchable = `${host}\n${text}`;

  let confidence = 0.4;
  const missing = [];

  const prior = HOST_PRIORS.find((p) => p.match.some((m) => lc(host).includes(m)));
  const facets = {
    observance: prior?.observance ?? null,
    kosher: prior?.kosher ?? null,
    shomerShabbat: prior?.shomerShabbat ?? null,
    mixedGender: prior?.mixedGender ?? null,
    prayer: null,
    beginnerFriendly: prior?.beginnerFriendly ?? null,
  };
  if (prior) confidence += 0.2;
  else missing.push('observance (no host prior matched)');

  for (const rule of OBSERVANCE_TEXT) {
    if (rule.re.test(text)) Object.assign(facets, rule.set);
  }

  const neighborhood = pickNeighborhood(`${raw.venue || ''} ${text}`);
  if (neighborhood) confidence += 0.15;
  else missing.push('neighborhood');

  const types = pickTypes(text, raw.rawCategories);
  if (types.length) confidence += 0.1;
  else missing.push('event type');

  const ages = pickAges(text);
  if (ages) confidence += 0.1;
  else missing.push('age range');

  const cost = pickCost(text, raw.offers);
  if (cost) confidence += 0.05;
  else missing.push('cost');

  // A Friday-evening event with no observance signal is the highest-risk row in
  // the dataset: it is exactly the case where a wrong guess strands someone.
  const day = new Date(raw.start).getUTCDay();
  const risky = (day === 5 || day === 6) && facets.observance == null;

  return {
    ...raw,
    host,
    neighborhood,
    types,
    ageMin: ages?.ageMin ?? null,
    ageMax: ages?.ageMax ?? null,
    singlesOriented: types.includes('singles'),
    ...facets,
    free: cost?.free ?? null,
    costMin: cost?.costMin ?? null,
    costMax: cost?.costMax ?? null,
    sourceId,
    confidence: Math.min(0.95, Number(confidence.toFixed(2))),
    needsReview: confidence < 0.7 || risky,
    missing,
  };
}

export const _internals = { pickNeighborhood, pickTypes, pickAges, pickCost };
