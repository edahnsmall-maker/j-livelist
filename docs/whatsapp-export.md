# Getting events out of the WhatsApp thread

You're in the group, which is the whole ballgame — everything below is you
exercising access you already have. No bot, no extra number, no ban risk.

## The easy way: no install, no terminal

Open the **export checker** page, drag the `.zip` straight from WhatsApp onto it,
and it tells you immediately whether it parsed — messages found, people posting,
date range, flyers matched — and shows you the event candidates it pulled out,
flyer images included.

It runs **entirely in your browser**. The file is read on your device and never
leaves it: no upload, no server, no network request at all. That matters, because
an export contains every group member's name and often their phone number.

Locally that page is `web/check.html` (`npm run serve`, then
<http://localhost:5173/check.html>). It also builds to a single self-contained
file, `web/check.single.html`, that you can just double-click.

Do that first. Everything below is the command-line path, for when you want to
actually pull the events into the app.

## The full loop (needs Node)

**1. Export the thread.**

*iPhone:* open the group → tap the group name at the top → scroll to the bottom →
**Export Chat** → **Attach Media** → save to Files (or AirDrop to your Mac).

*Android:* open the group → **⋮** → **More** → **Export chat** → **Include media**
→ save to Drive or your computer.

Choose **with media**. Without it, every flyer becomes the line `image omitted`
and the most valuable posts in the thread arrive empty. The parser detects this
and warns you.

**2. Unzip it.** You get `_chat.txt` (iOS) or `WhatsApp Chat with <group>.txt`
(Android), plus the images alongside it.

**3. Check that it parses — before anything else.**

```bash
node harvester/whatsapp.mjs "_chat.txt" --media . --check
```

That prints a health report and **writes nothing, sends nothing, uploads
nothing.** It runs entirely on your machine. Example:

```
  ok   messages parsed        9
  ok   system events           2 (joins, renames, encryption notice)
  ok   unparsed lines          0
  ok   distinct authors        4
  ok   date range              2026-08-19 → 2026-08-21
  ok   unparseable dates       0
  ok   date format detected    month-first (8/19/26)
  ok   attachments referenced  1
  ok   media omitted           0
  ok   event candidates        4 (1 with a flyer)

  OK — this export parses cleanly.
```

**4. Extract the events.**

```bash
export ANTHROPIC_API_KEY=sk-...
npm i @anthropic-ai/sdk
node harvester/whatsapp.mjs "_chat.txt" --media . --llm --out data/whatsapp.json
npm run build:data
npm run serve
```

## Reading the health check

The report is designed so you can trust or distrust the export in ten seconds.

| Line | What to do if it looks wrong |
|---|---|
| **messages parsed: 0** | The format isn't one the parser knows. Send me the first three lines of the file (they contain no message content) and I'll add it. |
| **unparsed lines > 0** | Usually harmless export headers. The report prints them so you can see. |
| **unparseable dates > 0** | Check the detected date format line. If it says month-first and your phone is set to day-first, tell me and I'll pin it. |
| **date format** | The parser decides this from the whole file: if any date's first number is over 12, it can only be a day. Ambiguous files default to US month-first. |
| **media omitted > 0, attachments 0** | You exported without media. Re-export with **Attach Media**. |
| **media files matched < referenced** | The `.txt` and the images got separated. Point `--media` at the folder holding the images. |
| **distinct authors: 1** | Something collapsed. Worth flagging to me. |
| **event candidates** | Should be a small fraction of messages. If it's near-zero on a busy thread, the filter is too strict and I'll loosen it. |

## What gets sent to the model, and what doesn't

Only messages that survive the event filter, and only when you pass `--llm`.
`--check` is fully offline.

The filter drops: messages under 25 characters, deleted messages, pure reactions,
`image omitted` placeholders, and anything that doesn't carry at least two
event-ish signals (a time, a weekday, a date, an RSVP verb, a link). On a typical
thread that's most of the volume — which keeps cost at roughly a penny to four
cents per flyer and near-zero for text.

Messages with an attachment always go through, because a posted flyer is the case
this exists for.

## The privacy thing worth deciding early

A WhatsApp export contains **every member's display name, and often their phone
number**, for every message in the thread. That file is a small pile of other
people's personal data.

So:

- `.gitignore` already excludes `chat.txt`, `media/`, and `*.txt.export`. Don't
  commit an export, ever.
- `data/whatsapp.json` keeps the author name on each record. If j-livelist ever
  becomes a shared repo or a hosted service, strip that field — the event needs
  the host's name, not the name of whoever happened to post it.
- Extracted events are fine to publish. The raw export is not.
- Worth telling the group at some point that you're aggregating the thread. Not a
  legal requirement among members; just the thing that keeps this a community
  project rather than a surprise.

## Making it a weekly habit

The whole loop is one command once the export is on disk. Realistically:

```bash
# Sunday morning, after exporting the week's thread
node harvester/whatsapp.mjs "_chat.txt" --media . --llm --out data/whatsapp.json
npm run build:data
```

If that ever feels like too much friction, the fix isn't a bot. It's asking the
group admin whether you can be a co-maintainer of a shared calendar, or standing
up a submission form and telling the thread to use it. Both are more reliable
than parsing chat, and both make organizers do the data entry for you.
