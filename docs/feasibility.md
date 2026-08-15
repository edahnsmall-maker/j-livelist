# j-livelist: what's actually hard here

Answers to the three questions, in the order you asked them. Short version up front:
**the app is easy, the harvesting is half-easy and half-closed, and the thing that
will actually decide whether this works is neither of those.**

---

## 1. Can we build a web app people pay $5 for?

**Building it: yes, and it's built.** `web/` is a working filterable list — age, event
type, neighborhood, cost, date, and level of observance. No backend, no build step;
it's a static page you can host on GitHub Pages or Vercel for free. Taking $5 is a
Stripe Payment Link and about thirty minutes of work.

So the technical answer is yes and it's boring. The interesting answer is that
**$5 one-time is a good demand test and a weak business model**, and it's worth
being clear-eyed about which one you're doing.

The arithmetic: LA has roughly 500–600k Jews. Suppose you reach an implausibly good
1% and convert an implausibly good 10% of those. That's ~500 payments — $2,500,
once. Even a runaway success at this price is a few thousand dollars, not income.
Meanwhile the WhatsApp thread you're competing with is free, already has the
network, and gets better as more people post to it.

That's not an argument against charging. It's an argument for being deliberate
about *why*:

- **As a demand test, $5 is excellent.** It's the cheapest way to learn whether
  people value curation enough to act. A signup form measures politeness; a
  credit card measures intent. The POC's paywall exists for exactly this.
- **As a quality filter, $5 works.** A paid list has fewer lurkers and a much
  better feedback loop — paying users tell you when a listing is wrong.
- **As revenue, look at organizers instead.** In events, the money is almost
  always on the supply side. Moishe House, OneTable, Federation, YJP, and every
  shul with a young-professionals arm all have the same problem you do in
  reverse: they cannot reach the right people. A curated, filterable audience is
  worth far more to them than $5 is to an attendee. Consider the attendee list
  free and monetize placement, or a "promoted event" slot, or a monthly digest
  sponsorship.

One thing to take seriously before charging: **once you take money for curation,
you own the curation.** If a paying user shows up at an event you labeled level 2
and finds a mechitza, that's a refund and a bad story. This is why the data model
below refuses to guess.

**Decision (August 2026): the app ships free.** The paywall is parked behind a
flag — `PAYWALL = false` at the top of `web/app.js` — rather than deleted, so the
demand test is one line away whenever it's worth running. Starting free is the
right call: with no proven list, a gate mostly measures how much you were
willing to charge for something nobody had evaluated yet. Get the list good,
then decide whether to charge, and probably charge organizers rather than
attendees.

---

## 2. Can we harvest the event sites and the WhatsApp channel?

Partly. The honest breakdown, by source, is in `data/sources.json`. Summary:

### First, the reframing that makes this tractable

**Stop thinking about "event sites."** Eventbrite isn't a source; it's a checkout
page that a hundred different organizations happen to use. Asking "does Eventbrite
work" produces a worse answer than asking the question that actually determines
everything:

> **What platform is this organization's website built on?**

Because the platform decides the method, and there are only about four answers:

| Platform | Open? | How you read it |
|---|---|---|
| **ShulCloud** | **Yes** | Documented iCal/WebCal export, per shul |
| **WordPress + The Events Calendar** | **Yes** | Free REST route, on by default |
| **Wix / Squarespace events** | **Yes** | schema.org JSON-LD in the page |
| **Chabad.org center sites** | **Yes** | Uniform platform — one adapter, many centers |
| Eventbrite / Luma / Partiful | Per-organizer | Readable page, but you must know the organizer |
| Facebook / Meetup | No | Closed |

To identify a site in about thirty seconds: view-source for `shulcloud` or an
`/ical` link → try `/wp-json/tribe/events/v1/events` → view-source for
`application/ld+json` → see where the RSVP button points. One of those four
almost always hits. The playbook is in `data/sources.json` under
`_platformPlaybook`.

**The best single find is ShulCloud.** It powers a large share of synagogue
websites and ships a sanctioned iCal export (*Export/WebCal → iCal/WebCal Export →
SETUP ICAL*). That's a structured, official, per-shul feed with no scraping and no
ToS question. Every LA shul running it is effectively already solved — you just
have to collect the URLs. Do that before writing another line of scraper.

### The specific ones you asked about

- **Eventbrite** — organizer pages work, platform-wide search doesn't. You need
  a hand-built list of organizer IDs. That list *is* the curation work, so it's
  less of a loss than it sounds.
- **Luma (lu.ma)** — this is probably the other one you were thinking of. Public
  calendar and event pages read fine without auth. Careful about the API: Luma
  *does* publish one (`public-api.luma.com`), but it's scoped to calendars **you
  own** — it's an organizer tool, not a discovery tool. So it's per-calendar, and
  you collect slugs by hand.
- **Partiful** — worth knowing about, not worth crawling. Very popular with
  exactly the 20s–30s crowd, but events are shared by link rather than listed,
  so there's no index to crawl. The right way in is the one you already have:
  when someone drops a Partiful link in the WhatsApp thread, follow it and parse
  the page.

So: **no, they won't all work — but the ones that don't matter less than they
look.** Roughly three-quarters of what you want sits on ShulCloud, WordPress,
Wix/Squarespace, or Chabad.org, all of which are open. The closed platforms are
mostly checkout pages for organizations you'll have on your list anyway.

### Open, and genuinely easy

These publish machine-readable data *on purpose* — reading it is what it's for.

| Method | What it is | Where you'll find it |
|---|---|---|
| **ICS feeds** | Standard calendar files | Most shul sites; look for "subscribe"/"export" |
| **The Events Calendar REST API** | `/wp-json/tribe/events/v1/events` | The WordPress events plugin, free and on by default. Very common on synagogue and federation sites |
| **JSON-LD** | `schema.org/Event` in the page HTML | Anything that shows up in Google's event results — Luma, Eventbrite organizer pages, most modern sites |
| **Hebcal** | Free public JSON API | Chag dates and LA candle-lighting times |

`harvester/adapters.mjs` implements all four. Hebcal isn't an events source — it's
the skeleton. It's what lets the app know that a Friday event starting at 7:30pm
in September starts *after* candle lighting, which is invisible to every generic
events app and decisive for a level-4 or level-5 user.

### Closed, and not coming back

- **Eventbrite platform search is gone.** Public access to the event search
  endpoint was removed in December 2019 and switched off entirely in February
  2020. What remains is by-event-id, by-venue, and by-organizer. There is no
  supported way to ask Eventbrite "what Jewish events are in LA." You *can* read
  a known organizer's page — which means maintaining a hand-built list of
  organizer IDs. That hand-built list is the curation work you're selling anyway,
  so this is less of a loss than it sounds.
- **Facebook event search died in the 2018 platform lockdown** and never came
  back. The "LA Jewish Events Calendar" Facebook page is real, active, and
  functionally unreadable by machine. Treat it as manual or as a partnership.
- **Meetup** is behind OAuth and a paid tier, with low Jewish-event density in
  LA. Not worth it early.

### WhatsApp: use the export, not a bot

There are libraries (Baileys, whatsapp-web.js) that log into WhatsApp's
multi-device protocol and read a group automatically. **Don't.** They
reverse-engineer the protocol, they violate Meta's terms, and the current failure
mode is the phone number getting banned — including numbers that had run quietly
for years. The number in question is presumably yours, and it's presumably in
that group and forty others. That's a bad thing to gamble.

The legitimate path gets the same data: WhatsApp's own **"Export chat"**. You're
in the group, so this is just you exercising access you already have.
`harvester/whatsapp.mjs` handles both iOS and Android formats, day-first and
month-first dates, 12- and 24-hour times, multi-line messages, attachments,
edits, deletions, and the invisible characters WhatsApp sprinkles through the
file. Step-by-step instructions are in [`whatsapp-export.md`](whatsapp-export.md).

**Run `--check` against your real export before trusting any of it:**

```
node harvester/whatsapp.mjs "_chat.txt" --media . --check
```

That prints a health report — messages parsed, authors found, date range, date
format detected, attachments matched, unparsed lines, event candidates — and
**writes nothing and sends nothing.** It's entirely local, which matters because
an export contains every member's display name and often their phone number.

Two failure modes it's specifically designed to catch: exporting *without* media
(every flyer becomes the string `image omitted`, and it will tell you so), and a
date format the parser guessed wrong.

One bug worth recording, because it's the kind that produces plausible garbage
rather than an error: the first version treated any line without an `Author:`
prefix as a continuation of the previous message. WhatsApp system lines —
"Yael added Moshe", "Ari changed the group description", the encryption notice —
have no author prefix, so they were being silently welded onto the end of real
messages. Fixed, and there's now a test for it.

Cost: about one manual step a week. In exchange you keep your phone number.

If the volume ever justifies removing that step, the upgrade isn't a bot — it's
asking the group admin for a co-maintained feed, or standing up a submission form
that organizers post to directly.

### Flyers: solved, and cheap

The "some are just flyers" problem is the one I expected to be hard and isn't.
Claude reads an event flyer image and returns a structured record —
`harvester/enrich.mjs` does this with a JSON schema so the output is validated
rather than parsed out of prose.

Measured cost per flyer, at published rates:

| Model | Image | Per flyer | 100 flyers/wk | Per year |
|---|---|---|---|---|
| Claude Opus 5 | downscaled to 1568px | $0.027 | $2.65 | $138 |
| Claude Opus 5 | full 2576px | $0.042 | $4.24 | $221 |
| Claude Haiku 4.5 | downscaled | $0.005 | $0.53 | $28 |
| Claude Haiku 4.5 | full | $0.009 | $0.85 | $44 |

The code defaults to Opus 5 for accuracy; Haiku 4.5 is a one-line change if you
want to trade some of it for a 5× cost reduction (`estimateFlyerCost()` in
`harvester/enrich.mjs` recomputes any of these). Either way, **parsing cost is not
a constraint on this business at any realistic volume.**

### The thing that's actually hard

Not scraping. Not cost. It's that **the field you most want to filter on does not
exist in any source.**

Nobody publishes "level of observance" as structured data. No shul tags its
events "mechitza: true." Eventbrite has no kosher field. That information lives in
what people already know about the institution, or in a line of flyer copy like
"please dress modestly," or nowhere at all.

So the honest framing is: you are not harvesting this data, **you are creating
it.** That's the real work, and it's also the real moat — it's the part a
competitor can't scrape from you, and it's the part that makes the product worth
$5 when the raw listings are free.

`harvester/classify.mjs` does what can be automated:

- **Host priors.** The institution predicts the vibe better than any keyword in
  the copy. Chabad → level 5, IKAR → level 2, and so on.
- **Text overrides.** "Mechitza," "women only," "no phones," "transliteration
  provided" override the prior, because they describe the specific event.
- **Explicit refusal to guess.** When nothing matches, the field stays `null` and
  the record is flagged `needsReview` rather than filled in with a plausible
  number. A Friday or Saturday event with no observance signal is *always*
  flagged, because that's the case where a wrong label strands someone.

That last rule is the most important line of code in the project. A missing label
costs you a filter hit. A wrong label sends someone to a room where they feel out
of place — which is the exact experience this app exists to prevent.

### One caveat on the source list

I built and tested this in a sandbox with outbound network access disabled, so
**every URL in `data/sources.json` is an unverified hypothesis.** The parsers are
tested against real payload formats (`npm test`, 12 passing), but the endpoints
themselves have not been hit. First thing to run on a normal machine:

```
npm run harvest -- --probe
```

That hits every candidate endpoint, reports which are live, and writes
`data/probe-report.json`. Update the `verified` flags from what it finds rather
than from what this document assumes.

---

## 3. Can we try a proof of concept first?

That's what this repo is. Deliberately: no database, no accounts, no framework, no
deploy. Everything runs from a checkout.

```
npm test                       # 12 tests: parsers, classifier, WhatsApp, cost model
npm run harvest -- --probe     # which sources are actually real?
npm run harvest                # harvest → classify → dedupe
npm run whatsapp -- chat.txt --media ./media --llm
npm run build:data             # assemble web/data.json
npm run serve                  # http://localhost:5173
```

With no harvest run, the app loads a labeled sample set of 32 events and says so
in a banner on every page. A demo that quietly looks like live data is how a POC
misleads the person it's meant to inform.

### What the POC proves

- The filter model works and produces genuinely useful cuts. Selecting levels 4–5
  and requiring Shabbat observance returns 3 of 32 events — Pico Shul, a Young
  Israel singles lunch, and Chabad tashlich. That is the correct answer, and no
  existing LA Jewish listing can produce it.
- Flyer and free-text extraction is a solved problem at negligible cost.
- The structured-data plumbing (ICS, JSON-LD, WordPress REST, Hebcal) is real
  code with real tests, not a sketch.

### What it does not prove

- That anyone will pay. The paywall records intent in `localStorage`; it is not
  Stripe.
- That the sources are live. See the probe caveat above.
- That auto-classification is accurate enough on real data. It's rules-first,
  tuned against invented examples. Real listings will break it in ways I can't
  predict from here.

### The two-week test I'd actually run

1. **Probe the sources** (an hour). Find out how many of the 14 candidates are
   real. If six or more are live, supply is not your problem.
2. **Export the WhatsApp thread once** and run it through the parser with `--llm`.
   Read the output next to the raw thread and count the errors. This tells you
   your true classification accuracy in about twenty minutes — the single most
   important unknown.
3. **Hand-label one week of events** for observance and facets. Time it. If a week
   takes under an hour, curation is tractable solo and you should stop optimizing
   the scraper.
4. **Put the list in front of 30 people with a real Stripe link.** Not a survey —
   a link. Count clicks, then count payments. The gap between those two numbers
   is the most honest thing you will learn.

If step 4 converts and step 3 takes under an hour a week, build it properly. If
step 4 flatlines, you've learned it for the price of a weekend, and the answer is
probably to flip the model to the organizer side rather than to abandon it.

---

## What I'd build next, in order

1. **A review queue.** The `needsReview` flag exists and nothing consumes it. One
   page listing flagged events with the fields to fill in turns curation from a
   chore into a five-minute daily habit — and it's what makes the data asset
   compound.
2. **An organizer submission form.** Every aggregator eventually converges on
   this. It's zero legal risk, the highest-quality data you'll get, and it
   inverts the relationship: instead of chasing sources, they come to you.
3. **Candle-lighting awareness.** The Hebcal adapter is written but unused by the
   app. Flagging a Friday event that starts after candle lighting is a small
   feature that no competitor has and that observant users will notice
   immediately.
4. **Saved filters and a weekly email.** The filter set *is* the user profile.
   "Your Thursday email: 4 events for a 32-year-old in Venice who wants mixed
   seating and no service" is a much easier thing to charge for than a website,
   because it does the remembering for them.
