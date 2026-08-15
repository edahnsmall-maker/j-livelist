// Fold the web pages into self-contained single files.
//
// Output is page content only — no <html>/<head>/<body> wrapper — so each can be
// published as an artifact (which supplies the skeleton) and still opens fine as
// a local file, since browsers tolerate a fragment.
//
//   npm run build:data && npm run build:single

import { readFile, writeFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

/** Strip ES module syntax so a module can run inside a plain <script> tag. */
const deModule = (src) =>
  src
    .replace(/^\s*import[^;]+;$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function|const|let|class)/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]+['"])?\s*;?$/gm, '');

function bodyOf(html) {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
  if (!body) throw new Error('no <body> found');
  return body;
}

const [indexHtml, checkHtml, styles, checkCss, appJs, checkJs, waParse, data] = await Promise.all([
  read('../web/index.html'),
  read('../web/check.html'),
  read('../web/styles.css'),
  read('../web/check.css'),
  read('../web/app.js'),
  read('../web/check.js'),
  read('../shared/wa-parse.mjs'),
  read('../web/data.json'),
]);

const favicon = (emoji) =>
  `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='14'>${emoji}</text></svg>">`;

/* ---------- the events app ---------- */

const appBody = bodyOf(indexHtml)
  .replace(/<script[^>]*src=["']app\.js["'][^>]*><\/script>/i, '')
  .trim();

// </script> inside the JSON payload would close the tag early.
const safeData = data.replace(/<\/script/gi, '<\\/script');

await writeFile(
  new URL('../web/index.single.html', import.meta.url),
  `<title>j-livelist</title>
${favicon('🕯️')}
<style>
${styles}
</style>

${appBody}

<script>window.__DATA__ = ${safeData};</script>
<script>
${appJs}
</script>
`,
);

/* ---------- the export checker ---------- */

// Keep the theme toggle, drop the module script tag; both scripts are inlined.
const checkBody = bodyOf(checkHtml)
  .replace(/<script[^>]*src=["']check\.js["'][^>]*><\/script>/i, '')
  .trim();

await writeFile(
  new URL('../web/check.single.html', import.meta.url),
  `<title>WhatsApp Export Checker</title>
${favicon('🔍')}
<style>
${styles}
${checkCss}
</style>

${checkBody}

<script>
${deModule(waParse)}
${deModule(checkJs)}
</script>
`,
);

for (const f of ['index.single.html', 'check.single.html']) {
  const size = (await read(`../web/${f}`)).length / 1024;
  console.log(`wrote web/${f} (${size.toFixed(0)} KB, self-contained)`);
}
