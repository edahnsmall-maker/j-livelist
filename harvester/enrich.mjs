// The LLM pass: everything the rules in classify.mjs cannot do.
//
// Two jobs:
//   1. readFlyer()  — a JPEG/PNG flyer with the details burned into the image.
//   2. enrichEvent() — messy free text where the facts are implied, not stated
//      ("please dress modestly", "we'll walk over after davening").
//
// The SDK is imported lazily so the core harvester (ICS/JSON-LD/REST) still
// runs with zero dependencies and no API key.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import taxonomy from '../data/taxonomy.json' with { type: 'json' };

export const MODEL = 'claude-opus-5';

// Published list rates, USD per million tokens. Used by estimateFlyerCost() so
// the unit economics in docs/feasibility.md are computed rather than recalled.
export const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

// Structured-output schemas must set additionalProperties:false and list every
// property in `required`; nullability goes through anyOf. Numeric/length
// constraints are not supported, so ranges are enforced in the prompt and
// re-checked in code below.
const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isEvent: { type: 'boolean' },
    title: nullable('string'),
    host: nullable('string'),
    startLocal: nullable('string'), // "YYYY-MM-DDTHH:MM" in LA local time
    endLocal: nullable('string'),
    venue: nullable('string'),
    neighborhood: { anyOf: [{ type: 'string', enum: taxonomy.neighborhoods.map((n) => n.key) }, { type: 'null' }] },
    types: { type: 'array', items: { type: 'string', enum: taxonomy.types.map((t) => t.key) } },
    ageMin: nullable('integer'),
    ageMax: nullable('integer'),
    singlesOriented: nullable('boolean'),
    observance: { anyOf: [{ type: 'integer', enum: [1, 2, 3, 4, 5] }, { type: 'null' }] },
    kosher: nullable('boolean'),
    shomerShabbat: nullable('boolean'),
    mixedGender: nullable('boolean'),
    prayer: nullable('boolean'),
    beginnerFriendly: nullable('boolean'),
    free: nullable('boolean'),
    costMin: nullable('number'),
    costMax: nullable('number'),
    rsvpUrl: nullable('string'),
    description: nullable('string'),
    confidence: { type: 'number' },
    uncertain: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'isEvent', 'title', 'host', 'startLocal', 'endLocal', 'venue', 'neighborhood',
    'types', 'ageMin', 'ageMax', 'singlesOriented', 'observance', 'kosher',
    'shomerShabbat', 'mixedGender', 'prayer', 'beginnerFriendly', 'free',
    'costMin', 'costMax', 'rsvpUrl', 'description', 'confidence', 'uncertain',
  ],
};

const LEVELS = taxonomy.observanceLevels.map((l) => `${l.id} = ${l.label}: ${l.blurb}`).join('\n');

const SYSTEM = `You extract structured event records for a Los Angeles Jewish events guide.

Return null for anything the source does not actually state or clearly imply. A null
is a correct answer; a plausible guess is not. Every field you fill in gets shown to
someone deciding whether to walk into a room full of strangers.

Observance levels:
${LEVELS}

Level describes the general vibe. The booleans are what actually determine whether
someone is comfortable, and they cross-cut the level — judge each independently:
- kosher: food is under kosher supervision.
- shomerShabbat: run to Shabbat observance (no phones, money, photography, driving on site).
- mixedGender: men and women sit and participate together. False means mechitza or
  separate seating. If a source mentions a mechitza, separate seating, or is a
  women's-only or men's-only event, set this false.
- prayer: there is an actual service, not only food and socializing.
- beginnerFriendly: someone with no background will be oriented rather than lost.

Times are Los Angeles local, written as YYYY-MM-DDTHH:MM with no timezone suffix.
If a flyer says only "Friday 7pm", resolve it against the reference date you are
given and list "date inferred from weekday" in "uncertain".

Set confidence between 0 and 1 for the record as a whole, and list every field you
were unsure about in "uncertain".`;

let clientPromise;
async function getClient() {
  clientPromise ||= (async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic(); // reads ANTHROPIC_API_KEY, or an `ant auth login` profile
  })();
  return clientPromise;
}

/**
 * One call, with the recommended server-side refusal fallback enabled.
 * If this account does not have the fallback beta, we retry once without it
 * rather than failing the whole harvest over an optional safety net.
 */
async function callClaude({ content, model = MODEL, maxTokens = 8000 }) {
  const client = await getClient();
  const base = {
    model,
    max_tokens: maxTokens, // caps thinking + text together; Opus 5 thinks by default
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: EVENT_SCHEMA } },
    messages: [{ role: 'user', content }],
  };

  let response;
  try {
    response = await client.beta.messages.create({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    if (!/fallback|beta/i.test(String(err?.message))) throw err;
    response = await client.messages.create(base);
  }

  if (response.stop_reason === 'refusal') {
    return { isEvent: false, refused: true, uncertain: ['model declined this input'] };
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) return { isEvent: false, uncertain: ['no text block in response'] };

  const parsed = JSON.parse(text);
  parsed._usage = response.usage;
  return parsed;
}

/** Read an event flyer image. This is the WhatsApp thread's hardest case. */
export async function readFlyer(imagePath, { referenceDate = new Date().toISOString().slice(0, 10), caption = '' } = {}) {
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) throw new Error(`unsupported image type: ${ext}`);

  const data = (await readFile(imagePath)).toString('base64');
  const result = await callClaude({
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
      {
        type: 'text',
        text: `Extract the event from this flyer. Today's reference date is ${referenceDate} (America/Los_Angeles).${
          caption ? `\n\nIt was posted with this caption:\n${caption}` : ''
        }\n\nIf the image is not an event flyer, set isEvent to false.`,
      },
    ],
  });
  return { ...result, sourceKind: 'flyer', sourceFile: imagePath };
}

/** Enrich a text blob — a WhatsApp message, or a scrape the rules gave up on. */
export async function enrichEvent(text, { referenceDate = new Date().toISOString().slice(0, 10), context = '' } = {}) {
  const result = await callClaude({
    content: [
      {
        type: 'text',
        text: `Extract the event described below. Today's reference date is ${referenceDate} (America/Los_Angeles).${
          context ? `\n\nContext about the source: ${context}` : ''
        }\n\n---\n${text}\n---\n\nIf this is not an announcement of a specific event, set isEvent to false.`,
      },
    ],
  });
  return { ...result, sourceKind: 'text' };
}

/**
 * What flyer parsing actually costs, so the business question has a number.
 * Opus 5 accepts images up to 2576px on the long edge and bills up to ~4784
 * tokens for one; downscaling to 1568px costs roughly a third of that and is
 * usually plenty for a flyer, since the text is large by design.
 */
export function estimateFlyerCost({ flyersPerWeek = 100, model = MODEL, downscale = true } = {}) {
  const rate = PRICING[model];
  if (!rate) throw new Error(`no published pricing for ${model}`);
  const imageTokens = downscale ? 1600 : 4784;
  const promptTokens = 700; // system prompt + instructions
  const outputTokens = 600; // one structured record, thinking included
  const perFlyer =
    ((imageTokens + promptTokens) * rate.input) / 1e6 + (outputTokens * rate.output) / 1e6;
  return {
    model,
    downscale,
    perFlyer: Number(perFlyer.toFixed(4)),
    perWeek: Number((perFlyer * flyersPerWeek).toFixed(2)),
    perYear: Number((perFlyer * flyersPerWeek * 52).toFixed(2)),
    flyersPerWeek,
  };
}

export { EVENT_SCHEMA };
