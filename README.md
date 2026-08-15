# j-livelist

LA Jewish events, curated and filterable — by age, event type, neighborhood, cost,
and level of observance.

This is a **proof of concept**, built to answer three questions before anyone
commits to building the real thing:

1. Can we ship a web app worth paying for? (The app ships **free** — the $5 gate
   is parked behind a flag in `web/app.js`.)
2. Can we harvest events from event sites and the WhatsApp thread?
3. Can we find out cheaply, before building?

**The answers are in [`docs/feasibility.md`](docs/feasibility.md).** Read that first —
this file is just how to run it.

## Quick start

No build step, no database, no accounts. Node 18+.

```bash
npm test                    # 12 tests: parsers, classifier, WhatsApp, cost model
npm run build:data          # assemble web/data.json (uses sample data until you harvest)
npm run serve               # http://localhost:5173
```

The app loads a **labeled sample set of 32 events** until a harvest has run, and
says so in a banner. Those events are hand-written to exercise every filter path.
The organizations are real LA institutions; the specific events, times, and prices
are invented. Don't show them to anyone as real listings.

## Harvesting real events

```bash
npm run harvest -- --probe   # test every candidate source, write data/probe-report.json
npm run harvest              # harvest → classify → dedupe → data/events.harvested.json
npm run build:data           # fold into web/data.json
```

`--probe` first. Every URL in `data/sources.json` is an unverified hypothesis —
this repo was built in a sandbox without outbound network access, so no endpoint
has actually been hit. The probe tells you which are real; update the `verified`
flags from what it finds.

## WhatsApp

Via WhatsApp's own **"Export chat"** feature, not a bot. See the feasibility memo
for why that distinction matters (short version: protocol bots violate Meta's
terms and get phone numbers banned).

```bash
npm run whatsapp -- "_chat.txt" --media . --check    # health check: fully local, writes nothing
npm run whatsapp -- "_chat.txt" --media . --llm      # extract events
```

**No terminal? Open `web/check.html`** (or the standalone `web/check.single.html`)
and drag the `.zip` onto it. Same parser, runs entirely in the browser, nothing
uploaded — it reports whether the export is readable and shows the event
candidates with their flyers.

**On the command line, run `--check` first.** It reports messages parsed, authors, date range, date
format, attachments matched, and unparsed lines, so you know whether the export
is good before anything else happens. Full instructions:
[`docs/whatsapp-export.md`](docs/whatsapp-export.md).

`--llm` needs `ANTHROPIC_API_KEY` (or an `ant auth login` profile) and
`npm i @anthropic-ai/sdk`. It reads flyer images as well as text. Flyer parsing
costs roughly half a cent to four cents each depending on model and resolution —
see the table in the memo.

## Layout

```
data/taxonomy.json        the filter vocabulary — observance levels, facets, types, LA geography
data/sources.json         source registry: what each source is and how it can be read
data/events.seed.json     labeled sample events (clearly marked, not real listings)
harvester/adapters.mjs    ICS, JSON-LD, WordPress Events Calendar REST, Hebcal
harvester/classify.mjs    free text → filter fields, with an explicit refusal to guess
harvester/enrich.mjs      Claude pass: flyer vision + structured extraction
harvester/whatsapp.mjs    WhatsApp export parser
shared/wa-parse.mjs       WhatsApp parsing — shared by the CLI and the browser checker
web/                      the app + the export checker — static, no framework
docs/feasibility.md       the actual answers
docs/whatsapp-export.md   how to export the thread and verify it parsed
```

## The one design decision worth knowing

Level of observance is a 1–5 scale, but the scale is *not* the filter that matters.
The booleans are: kosher, shomer Shabbat, mixed seating, includes prayer, beginner
friendly. They cross-cut the scale — plenty of Reform events are strictly kosher,
plenty of Orthodox events are mixed-gender socially — so they're stored and
filtered independently.

And when the classifier can't tell, it stores `null` and flags the event for review
rather than guessing. A missing label costs a filter hit; a wrong one sends someone
to a room where they feel out of place, which is the thing this app exists to
prevent.
