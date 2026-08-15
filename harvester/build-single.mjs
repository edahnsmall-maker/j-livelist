// Fold web/ into one self-contained HTML file with the data inlined.
//
// Output is page content only — no <html>/<head>/<body> wrapper — so it can be
// published as an artifact (which supplies the skeleton) and still opens fine
// as a local file, since browsers tolerate a fragment.
//
//   npm run build:data && npm run build:single

import { readFile, writeFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

const [html, css, js, data] = await Promise.all([
  read('../web/index.html'),
  read('../web/styles.css'),
  read('../web/app.js'),
  read('../web/data.json'),
]);

const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
if (!body) throw new Error('could not find <body> in web/index.html');

// Drop the external <link>/<script> references; both are inlined below.
const content = body
  .replace(/<script[^>]*src=["']app\.js["'][^>]*><\/script>/i, '')
  .trim();

// </script> inside the JSON payload would close the tag early.
const safeData = data.replace(/<\/script/gi, '<\\/script');

const out = `<title>j-livelist</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='14'>🕯️</text></svg>">
<style>
${css}
</style>

${content}

<script>window.__DATA__ = ${safeData};</script>
<script>
${js}
</script>
`;

await writeFile(new URL('../web/index.single.html', import.meta.url), out);
console.log(`wrote web/index.single.html (${(out.length / 1024).toFixed(0)} KB, self-contained)`);
