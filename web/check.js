/* WhatsApp export checker — runs entirely in the browser.
   Nothing is uploaded. There is no fetch, no XHR, no form post anywhere in this
   file; the export is read with FileReader and stays in the tab until you close it. */

import { parseExport, parsePasted, looksLikeEvent, healthCheck, verdict } from '../shared/wa-parse.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k) n.append(k);
  return n;
};

/* ---------- minimal ZIP reader ----------
   WhatsApp exports arrive as a .zip. Rather than make you unzip it first, read
   it here: walk the central directory, then inflate each entry with the
   browser's built-in DecompressionStream. No library, no upload. */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

function readZip(buffer) {
  const dv = new DataView(buffer);
  const len = buffer.byteLength;

  // The end-of-central-directory record sits at the end, possibly behind a
  // trailing comment, so scan backwards for its signature.
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This does not look like a .zip file.');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];

  for (let n = 0; n < count && p + 46 <= len; n++) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true);
    const exLen = dv.getUint16(p + 30, true);
    const cmLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buffer, p + 46, fnLen));

    // The local header repeats the name/extra with its own lengths.
    const localFnLen = dv.getUint16(localOffset + 26, true);
    const localExLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localFnLen + localExLen;

    if (dataStart + compressedSize <= len && !name.endsWith('/')) {
      files.push({ name, method, bytes: new Uint8Array(buffer, dataStart, compressedSize) });
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  return files;
}

async function inflate(entry) {
  if (entry.method === 0) return entry.bytes; // stored
  if (entry.method !== 8) throw new Error(`Unsupported compression in ${entry.name}`);
  const stream = new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------- rendering ---------- */

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

function statRow(label, value, good) {
  return el('div', { className: `stat ${good === false ? 'bad' : ''}` }, [
    el('span', { className: 'stat-label', textContent: label }),
    el('span', { className: 'stat-value', textContent: String(value) }),
  ]);
}

function renderReport(report, mediaInfo) {
  const v = verdict(report);
  const out = $('results');
  out.replaceChildren();

  out.append(
    el('div', { className: `verdict ${v.level}` }, [
      el('strong', { textContent: { ok: 'Looks good.', warn: 'Parsed, with a caveat.', fail: 'Could not parse this.' }[v.level] }),
      ' ' + v.text,
    ]),
  );

  const stats = el('div', { className: 'stats' }, [
    statRow('Messages parsed', report.messages, report.messages > 0),
    statRow('People posting', report.authors, report.authors > 1),
    statRow('Date range', report.dateRange ? report.dateRange.join(' → ') : 'none', !!report.dateRange),
    statRow('Date format', report.dateFormat, true),
    statRow('Dates that failed', report.undatedMessages, report.undatedMessages === 0),
    statRow('Lines not understood', report.unparsedLines, report.unparsedLines === 0),
    statRow('System notices skipped', report.systemEvents, true),
    statRow('Messages with a flyer', report.attachments, true),
    statRow('Media missing from export', report.mediaOmitted, report.mediaOmitted === 0),
    statRow('Deleted / edited', `${report.deleted} / ${report.edited}`, true),
    statRow('Event candidates found', report.candidates, report.candidates > 0),
    mediaInfo
      ? statRow('Flyers matched to messages', `${mediaInfo.matched}/${mediaInfo.referenced}`, mediaInfo.matched === mediaInfo.referenced)
      : null,
  ]);
  out.append(stats);

  if (report.topAuthors.length) {
    out.append(
      el('div', { className: 'panel' }, [
        el('h3', { textContent: 'Top posters' }),
        el('p', { className: 'hint', textContent: 'A sanity check that names came through intact.' }),
        el('ul', { className: 'authors' }, report.topAuthors.map(([name, n]) =>
          el('li', {}, [el('span', { textContent: name }), el('b', { textContent: String(n) })]))),
      ]),
    );
  }
}

function renderCandidates(candidates, blobs) {
  const out = $('candidates');
  out.replaceChildren();
  if (!candidates.length) return;

  out.append(
    el('h2', { textContent: `${candidates.length} event candidates` }),
    el('p', {
      className: 'hint',
      textContent:
        'These are the messages the filter kept — the ones that carry a time, a date, an RSVP, or a flyer. ' +
        'Everything else in the thread was dropped before this point. In the full pipeline these go to the ' +
        'model, which turns each one into a structured event.',
    }),
  );

  for (const msg of candidates) {
    const img = msg.attachments.map((a) => blobs.get(a)).find(Boolean);
    out.append(
      el('article', { className: 'cand' }, [
        el('div', { className: 'cand-head' }, [
          el('span', { className: 'cand-author', textContent: msg.author || 'unknown' }),
          el('span', { className: 'cand-date', textContent: `${msg.isoDate || msg.date} · ${msg.time}` }),
        ]),
        msg.text ? el('p', { className: 'cand-text', textContent: msg.text }) : null,
        img ? el('img', { className: 'cand-img', src: img, alt: 'Flyer posted with this message', loading: 'lazy' }) : null,
        msg.attachments.length && !img
          ? el('p', { className: 'hint', textContent: `Attachment referenced but not found in the file: ${msg.attachments[0]}` })
          : null,
      ]),
    );
  }
}

/** Flyers dropped without a chat file. Nothing to parse — but plenty to say. */
function renderFlyersOnly(blobs) {
  const out = $('results');
  out.replaceChildren(
    el('div', { className: 'verdict ok' }, [
      el('strong', { textContent: `${blobs.size} flyer${blobs.size === 1 ? '' : 's'} loaded. ` }),
      'This is the path that still works when a group has export switched off — you can open a flyer and share it.',
    ]),
    el('div', { className: 'panel' }, [
      el('h3', { textContent: 'Turning these into events' }),
      el('p', {
        className: 'hint',
        textContent:
          'Reading a flyer means running it through a vision model, which is the one step that cannot happen ' +
          'in this page: it needs a network call, and this page deliberately makes none. Two ways to do it — ' +
          'run `npm run whatsapp -- --llm` locally with an API key, or just hand the flyers to Claude in the ' +
          'conversation and have it extract them. At a few cents each, neither is a cost decision.',
      }),
    ]),
  );

  const grid = el('div', { className: 'flyers' });
  for (const [name, url] of blobs) {
    grid.append(
      el('figure', { className: 'flyer' }, [
        el('img', { src: url, alt: name, loading: 'lazy' }),
        el('figcaption', { textContent: name }),
      ]),
    );
  }
  out.append(grid);
}

/* ---------- file handling ---------- */

async function handleFiles(fileList) {
  const files = [...fileList];
  $('results').replaceChildren(el('p', { className: 'hint', textContent: 'Reading…' }));
  $('candidates').replaceChildren();

  try {
    let chatText = null;
    const blobs = new Map(); // attachment filename → object URL

    for (const f of files) {
      if (f.name.toLowerCase().endsWith('.zip')) {
        const entries = readZip(await f.arrayBuffer());
        for (const entry of entries) {
          const base = entry.name.split('/').pop();
          if (base.toLowerCase().endsWith('.txt')) {
            chatText = new TextDecoder().decode(await inflate(entry));
          } else if (IMAGE_EXT.test(base)) {
            const bytes = await inflate(entry);
            blobs.set(base, URL.createObjectURL(new Blob([bytes])));
          }
        }
      } else if (f.name.toLowerCase().endsWith('.txt')) {
        chatText = await f.text();
      } else if (IMAGE_EXT.test(f.name)) {
        blobs.set(f.name, URL.createObjectURL(f));
      }
    }

    // Flyers on their own, with no chat file. This is the normal case when a
    // group has export disabled: you can still open a flyer and share it.
    if (!chatText && blobs.size) {
      renderFlyersOnly(blobs);
      $('drop').classList.add('done');
      return;
    }

    if (!chatText) {
      $('results').replaceChildren(
        el('div', { className: 'verdict fail' }, [
          el('strong', { textContent: 'Nothing readable in that. ' }),
          'Drop the .zip from WhatsApp, the _chat.txt inside it, or some flyer images.',
        ]),
      );
      return;
    }

    const parsed = parseExport(chatText);
    const report = healthCheck(parsed);
    const candidates = parsed.messages.filter(looksLikeEvent);

    // Attachment names in the text don't always match the media filenames
    // byte-for-byte, so fall back to a stem match.
    const resolve = (name) => {
      if (blobs.has(name)) return blobs.get(name);
      const stem = name.replace(/\.[^.]+$/, '');
      for (const [k, url] of blobs) if (k.includes(stem) || stem.includes(k.replace(/\.[^.]+$/, ''))) return url;
      return null;
    };
    const resolved = new Map();
    let referenced = 0;
    let matched = 0;
    for (const c of candidates) {
      for (const a of c.attachments) {
        referenced++;
        const url = resolve(a);
        if (url) { resolved.set(a, url); matched++; }
      }
    }

    renderReport(report, referenced ? { referenced, matched } : null);
    renderCandidates(candidates, resolved);
    $('drop').classList.add('done');
  } catch (err) {
    $('results').replaceChildren(
      el('div', { className: 'verdict fail' }, [
        el('strong', { textContent: 'Could not read that file. ' }),
        String(err?.message || err),
      ]),
    );
  }
}

/** Pasted posts, for groups where export is switched off. */
function handlePaste(text) {
  const parsed = parsePasted(text);
  if (!parsed.messages.length) {
    $('results').replaceChildren(
      el('div', { className: 'verdict fail' }, [
        el('strong', { textContent: 'Nothing to read there. ' }),
        'Paste at least one post — a couple of sentences is plenty.',
      ]),
    );
    $('candidates').replaceChildren();
    return;
  }

  if (parsed.mode === 'export') {
    // The paste kept its timestamps, so it is export-shaped: full report.
    renderReport(healthCheck(parsed), null);
    renderCandidates(parsed.messages.filter(looksLikeEvent), new Map());
    return;
  }

  // Bare text. No filtering — these were pasted deliberately.
  $('results').replaceChildren(
    el('div', { className: 'verdict ok' }, [
      el('strong', { textContent: `${parsed.messages.length} post${parsed.messages.length === 1 ? '' : 's'} read. ` }),
      'No timestamps in this paste, so each block is treated as one post and nothing is filtered out — ' +
        'you already did the choosing. Dates will be resolved when these are extracted.',
    ]),
  );
  renderCandidates(parsed.messages, new Map());
}

/* ---------- wiring ---------- */

const drop = $('drop');
const input = $('file');

$('paste-go').addEventListener('click', () => handlePaste($('paste').value));

drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
});
input.addEventListener('change', () => input.files.length && handleFiles(input.files));

for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
drop.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});
