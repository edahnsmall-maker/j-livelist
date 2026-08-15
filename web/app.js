/* j-livelist — filterable LA Jewish events list.
   Reads window.__DATA__ when the page has data inlined (single-file build),
   otherwise fetches data.json. No framework, no build step. */

(async function () {
  // The list is free. The paywall was built as a demand test and is parked, not
  // deleted — flip PAYWALL to true to run that test later without rebuilding it.
  const PAYWALL = false;
  const FREE_EVENTS = 6; // only consulted when PAYWALL is on

  const data = window.__DATA__ || (await fetch('data.json').then((r) => r.json()));
  const { taxonomy, events } = data;

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, kids = []) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of [].concat(kids)) n.append(k);
    return n;
  };

  /* ---------- banner + provenance ---------- */

  if (data.isSample) {
    $('banner').hidden = false;
    $('banner').innerHTML =
      '<strong>Sample data.</strong> These events are illustrative, hand-written to exercise the filters — ' +
      'not harvested listings. Run <code>npm run harvest</code> to replace them with real ones.';
  }
  $('provenance').textContent =
    `${events.length} events · ${data.counts.needsReview} flagged for review · built ${new Date(
      data.generatedAt,
    ).toLocaleString()}`;

  /* ---------- filter UI, generated from the taxonomy ---------- */

  const checkboxList = (host, items, { checked = false } = {}) => {
    for (const it of items) {
      const input = el('input', { type: 'checkbox', value: it.key ?? it.id, checked });
      host.append(el('label', { className: 'row' }, [input, ' ' + it.label]));
    }
    return () => [...host.querySelectorAll('input:checked')].map((i) => i.value);
  };

  const getLevels = checkboxList(
    $('levels'),
    taxonomy.observanceLevels.map((l) => ({ key: String(l.id), label: `${l.id} — ${l.label}` })),
  );
  const getTypes = checkboxList($('types'), taxonomy.types);
  const REGIONS = [...new Set(taxonomy.neighborhoods.map((n) => n.region))];
  const getRegions = checkboxList($('regions'), REGIONS.map((r) => ({ key: r, label: r })));

  // Facets are tri-state because the data is tri-state: yes, no, and not known.
  // Collapsing "unknown" into "no" would quietly lie about half the dataset.
  const facetSelects = {};
  for (const f of taxonomy.facets) {
    const sel = el('select', {}, [
      el('option', { value: 'any', textContent: 'Any' }),
      el('option', { value: 'yes', textContent: 'Required' }),
      el('option', { value: 'no', textContent: 'Excluded' }),
    ]);
    facetSelects[f.key] = sel;
    const wrap = el('label', { className: 'row', style: 'display:block' }, [
      f.label,
      sel,
      el('span', { className: 'help', textContent: f.help }),
    ]);
    $('facets').append(wrap);
  }

  /* ---------- filtering ---------- */

  function readFilters() {
    const levels = getLevels().map(Number);
    return {
      q: $('q').value.trim().toLowerCase(),
      age: $('age').value ? Number($('age').value) : null,
      singles: $('singles').checked,
      levels,
      unlabeled: $('unlabeled').checked,
      facets: Object.fromEntries(Object.entries(facetSelects).map(([k, s]) => [k, s.value])),
      types: getTypes(),
      regions: getRegions(),
      windowDays: Number($('window').value),
      free: $('free').checked,
      maxCost: $('maxcost').value ? Number($('maxcost').value) : null,
    };
  }

  function matches(ev, f) {
    if (f.q) {
      const hay = `${ev.title} ${ev.host || ''} ${ev.description} ${ev.neighborhoodLabel}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }

    // An event with no stated age range is open to everyone; excluding it would
    // hide most of the calendar.
    if (f.age != null && ev.ageMin != null && ev.ageMax != null) {
      if (f.age < ev.ageMin || f.age > ev.ageMax) return false;
    }
    if (f.singles && !ev.singlesOriented) return false;

    if (f.levels.length) {
      if (ev.observance == null) {
        if (!f.unlabeled) return false;
      } else if (!f.levels.includes(ev.observance)) return false;
    } else if (!f.unlabeled && ev.observance == null) return false;

    for (const [key, want] of Object.entries(f.facets)) {
      if (want === 'any') continue;
      if (want === 'yes' && ev[key] !== true) return false;
      if (want === 'no' && ev[key] !== false) return false;
    }

    if (f.types.length && !ev.types.some((t) => f.types.includes(t))) return false;
    if (f.regions.length && !f.regions.includes(ev.region)) return false;

    const days = (Date.parse(ev.start) - Date.now()) / 86400000;
    if (days > f.windowDays) return false;

    if (f.free && ev.free !== true) return false;
    if (f.maxCost != null) {
      const price = ev.free ? 0 : ev.costMin;
      if (price == null || price > f.maxCost) return false;
    }
    return true;
  }

  /* ---------- rendering ---------- */

  const LEVEL_LABEL = Object.fromEntries(taxonomy.observanceLevels.map((l) => [l.id, l.label]));
  const TYPE_LABEL = Object.fromEntries(taxonomy.types.map((t) => [t.key, t.label]));

  // Always render in Los Angeles time, never the viewer's. These are LA events:
  // a Friday 6:30pm candle-lighting dinner must not read as "Saturday 1:30 AM"
  // because the reader happens to be in London — or because a headless browser
  // defaults to UTC.
  const LA = 'America/Los_Angeles';
  const fmtDay = (iso) =>
    new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: LA });
  const fmtTime = (iso) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: LA });

  function priceLabel(ev) {
    if (ev.free) return 'Free';
    if (ev.costMin == null) return null;
    if (ev.costMax && ev.costMax !== ev.costMin) return `$${ev.costMin}–$${ev.costMax}`;
    return `$${ev.costMin}`;
  }

  function card(ev) {
    const chips = [];
    if (ev.observance != null) chips.push(['lv', `${ev.observance} · ${LEVEL_LABEL[ev.observance]}`]);
    else chips.push(['review', 'Observance unlabeled']);
    if (ev.kosher === true) chips.push(['', 'Kosher']);
    if (ev.shomerShabbat === true) chips.push(['', 'Shomer Shabbat']);
    if (ev.mixedGender === false) chips.push(['', 'Separate seating']);
    if (ev.mixedGender === true) chips.push(['', 'Mixed seating']);
    if (ev.prayer === true) chips.push(['', 'Includes prayer']);
    if (ev.beginnerFriendly === true) chips.push(['', 'Beginner friendly']);
    if (ev.singlesOriented) chips.push(['', 'Singles']);
    for (const t of ev.types) chips.push(['', TYPE_LABEL[t] || t]);
    const price = priceLabel(ev);
    if (price) chips.push([ev.free ? 'free' : '', price]);
    if (ev.needsReview) chips.push(['review', 'Needs review']);

    const ages =
      ev.ageMin != null && ev.ageMax != null && !(ev.ageMin === 0 && ev.ageMax === 120)
        ? ` · ages ${ev.ageMin}–${ev.ageMax}`
        : '';

    const title = ev.url
      ? el('h3', {}, [el('a', { href: ev.url, target: '_blank', rel: 'noopener', textContent: ev.title })])
      : el('h3', { textContent: ev.title });

    return el('article', { className: 'card' }, [
      el('div', { className: 'card-top' }, [
        title,
        el('span', { className: 'when', textContent: fmtTime(ev.start) }),
      ]),
      el('p', {
        className: 'meta',
        textContent: `${ev.host || 'Host unknown'} · ${ev.neighborhoodLabel}${ages}`,
      }),
      ev.description ? el('p', { className: 'desc', textContent: ev.description }) : '',
      el('div', { className: 'chips' }, chips.map(([cls, text]) => el('span', { className: `chip ${cls}`, textContent: text }))),
    ]);
  }

  const unlocked = () => !PAYWALL || localStorage.getItem('jll_unlocked') === '1';

  function render() {
    const f = readFilters();
    const hits = events.filter((ev) => matches(ev, f));
    const results = $('results');
    const gate = $('gate');
    results.replaceChildren();
    gate.replaceChildren();

    $('count').innerHTML = hits.length
      ? `<strong>${hits.length}</strong> event${hits.length === 1 ? '' : 's'} <em>of ${events.length}</em>`
      : 'No matches';

    if (!hits.length) {
      results.append(
        el('div', { className: 'empty' }, [
          'Nothing matches all of those at once. ',
          el('br'),
          'Try widening the observance range or the date window.',
        ]),
      );
      return;
    }

    const visible = unlocked() ? hits : hits.slice(0, FREE_EVENTS);
    let currentDay = null;
    let group;
    for (const ev of visible) {
      const day = fmtDay(ev.start);
      if (day !== currentDay) {
        currentDay = day;
        group = el('section', { className: 'daygroup' }, [el('div', { className: 'dayhead', textContent: day })]);
        results.append(group);
      }
      group.append(card(ev));
    }

    const hidden = hits.length - visible.length;
    if (hidden > 0) {
      gate.append(
        el('div', { className: 'gate' }, [
          el('h2', { textContent: `${hidden} more match your filters` }),
          el('p', {
            textContent:
              'The full curated list is $5 — one time, not a subscription. This POC does not take payment; ' +
              'the button records that you would have clicked it.',
          }),
          el('button', { className: 'btn primary', id: 'pay', type: 'button', textContent: 'Unlock the full list · $5' }),
          el('p', {
            className: 'note',
            textContent: 'Wire this to a Stripe Payment Link to turn it into a real willingness-to-pay test.',
          }),
        ]),
      );
      $('pay').onclick = () => {
        const clicks = Number(localStorage.getItem('jll_intent') || 0) + 1;
        localStorage.setItem('jll_intent', String(clicks));
        localStorage.setItem('jll_unlocked', '1');
        $('pay-body').textContent =
          `Recorded. In a real test this is where Stripe would open. You've clicked it ${clicks} time${
            clicks === 1 ? '' : 's'
          }; the rest of the list is now unlocked so you can keep exploring.`;
        $('pay-dialog').showModal();
        render();
      };
    }
  }

  /* ---------- wiring ---------- */

  for (const node of document.querySelectorAll('aside input, aside select')) {
    node.addEventListener('input', render);
  }
  $('reset').onclick = () => {
    document.querySelectorAll('aside input[type="checkbox"]').forEach((c) => (c.checked = c.id === 'unlabeled'));
    document.querySelectorAll('aside input[type="number"], aside input[type="search"]').forEach((i) => (i.value = ''));
    document.querySelectorAll('aside select').forEach((s) => (s.selectedIndex = 0));
    render();
  };
  $('explain').onclick = () => $('explain-dialog').showModal();
  $('theme-toggle').onclick = () => {
    const root = document.documentElement;
    const dark = root.getAttribute('data-theme') === 'dark' ||
      (!root.hasAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
  };

  render();
})();
