/* Event submission form.
   The design principle: ask a human only for what a model can't reliably infer.
   A flyer gives up title/date/time/place readily; it almost never states whether
   the food is kosher or whether there's a mechitza. So the flyer does the easy
   work and the person does the four hard fields — which keeps this to about
   thirty seconds while producing exactly the data the list is short of. */

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k) n.append(k);
  return n;
};

main();

async function main() {
// The vocabulary rides along in data.json, so the form and the list can never
// disagree about what the levels, facets, neighborhoods, or age bands are.
const { taxonomy } = window.__DATA__ ?? (await fetch('data.json').then((r) => r.json()));

/* ---------- build the vocabulary-driven controls ---------- */

for (const lv of taxonomy.observanceLevels) {
  $('observance').append(el('option', { value: String(lv.id), textContent: `${lv.id} — ${lv.label}` }));
}
$('observance').addEventListener('change', () => {
  const lv = taxonomy.observanceLevels.find((l) => String(l.id) === $('observance').value);
  $('obs-help').textContent = lv ? lv.blurb : 'Describes the general feel. The switches above matter more.';
});

for (const n of taxonomy.neighborhoods) {
  $('neighborhood').append(el('option', { value: n.key, textContent: n.label }));
}
for (const b of taxonomy.ageBands) {
  $('ages').append(el('option', { value: b.key, textContent: b.label }));
}

// Tri-state, because the data is tri-state. "Not sure" is the default and is a
// real answer — it routes the event to review instead of asserting something false.
const facetState = {};
for (const f of taxonomy.facets) {
  facetState[f.key] = null;
  const group = el('div', { className: 'facet' }, [
    el('div', { className: 'facet-q' }, [
      el('strong', { textContent: f.label }),
      el('span', { className: 'help', textContent: f.help }),
    ]),
  ]);
  const choices = el('div', { className: 'choices', role: 'group', 'aria-label': f.label });
  for (const [val, label] of [[true, 'Yes'], [false, 'No'], [null, 'Not sure']]) {
    const btn = el('button', {
      type: 'button',
      className: 'choice' + (val === null ? ' on' : ''),
      textContent: label,
    });
    btn.addEventListener('click', () => {
      facetState[f.key] = val;
      for (const sib of choices.children) sib.classList.remove('on');
      btn.classList.add('on');
    });
    choices.append(btn);
  }
  group.append(choices);
  $('facets').append(group);
}

/* ---------- flyer preview ---------- */

const flyers = [];

function renderPreview() {
  const box = $('preview');
  box.replaceChildren();
  flyers.forEach((f, i) => {
    box.append(
      el('figure', { className: 'flyer' }, [
        el('img', { src: f.url, alt: f.name }),
        el('figcaption', {}, [
          el('span', { textContent: f.name }),
          el('button', {
            type: 'button',
            className: 'btn link',
            textContent: 'remove',
            onclick: () => { URL.revokeObjectURL(f.url); flyers.splice(i, 1); renderPreview(); },
          }),
        ]),
      ]),
    );
  });
}

function addFiles(list) {
  for (const f of list) {
    if (!f.type.startsWith('image/')) continue;
    flyers.push({ name: f.name, url: URL.createObjectURL(f), size: f.size });
  }
  renderPreview();
}

const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); }
});
$('file').addEventListener('change', (e) => addFiles(e.target.files));
for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const t of ['dragleave', 'drop']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => e.dataTransfer?.files && addFiles(e.dataTransfer.files));

/* ---------- assemble ---------- */

function parseCost(raw) {
  const s = raw.trim().toLowerCase();
  if (!s) return { free: null, costMin: null, costMax: null };
  if (/free|no charge|donation|pay what/.test(s)) return { free: true, costMin: 0, costMax: 0 };
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!nums.length) return { free: null, costMin: null, costMax: null };
  return { free: false, costMin: Math.min(...nums), costMax: Math.max(...nums) };
}

function buildSubmission() {
  const band = taxonomy.ageBands.find((b) => b.key === $('ages').value);
  const cost = parseCost($('cost').value);
  const date = $('date').value;
  const time = $('time').value;

  return {
    _schema: 'j-livelist/submission@1',
    submittedAt: new Date().toISOString(),
    submitter: $('submitter').value.trim() || null,

    title: $('title').value.trim() || null,
    host: $('host').value.trim() || null,
    // Local wall-clock; the harvester attaches the LA offset for the date.
    startLocal: date ? `${date}T${time || '19:00'}` : null,
    neighborhood: $('neighborhood').value || null,
    url: $('url').value.trim() || null,
    description: $('blurb').value.trim() || null,

    ageMin: band ? band.min : null,
    ageMax: band ? band.max : null,
    ...cost,

    observance: $('observance').value ? Number($('observance').value) : null,
    ...facetState,

    flyers: flyers.map((f) => f.name),
    // Anything the submitter left alone stays null on purpose — the pipeline
    // flags those for review rather than inventing a value.
    needsReview: true,
  };
}

function missingBits(sub) {
  const gaps = [];
  if (!sub.title && !sub.description && !sub.flyers.length) gaps.push('a flyer, a name, or some details');
  if (!sub.startLocal && !sub.flyers.length) gaps.push('a date (or a flyer showing one)');
  return gaps;
}

$('build').addEventListener('click', async () => {
  const sub = buildSubmission();
  const gaps = missingBits(sub);
  const out = $('out');
  out.replaceChildren();

  if (gaps.length) {
    out.append(
      el('div', { className: 'verdict warn' }, [
        el('strong', { textContent: 'Almost — still need ' }),
        gaps.join(', ') + '.',
      ]),
    );
    $('copy').hidden = true;
    return;
  }

  const answered = taxonomy.facets.filter((f) => facetState[f.key] !== null).length;
  const json = JSON.stringify(sub, null, 2);

  out.append(
    el('div', { className: 'verdict ok' }, [
      el('strong', { textContent: 'Ready. ' }),
      `You answered ${answered} of ${taxonomy.facets.length} of the hard questions` +
        (answered < taxonomy.facets.length ? ' — the rest will be checked by hand.' : '. That is all of them, thank you.'),
    ]),
    flyers.length
      ? el('p', { className: 'hint', textContent: `Send the ${flyers.length} flyer image${flyers.length === 1 ? '' : 's'} along with this text — the flyer is read separately.` })
      : null,
    el('textarea', { className: 'payload', id: 'payload', rows: 12, readOnly: true, value: json }),
  );
  $('copy').hidden = false;
  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(json);
      $('copy').textContent = 'Copied';
      setTimeout(() => ($('copy').textContent = 'Copy to clipboard'), 1800);
    } catch {
      // Clipboard can be blocked; the textarea is right there either way.
      $('payload').select();
      $('copy').textContent = 'Select all, then copy';
    }
  };
});
}
