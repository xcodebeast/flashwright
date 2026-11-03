// Draws the cross-framework chart from two run.mjs results (1 and 4 workers):
//   node bench/competitors/chart.mjs <w1.json> <w4.json>
// Writes docs/media/competitors.svg and competitors-dark.svg, and the bars between the
// `competitors:start` / `competitors:end` markers in site/index.html.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [w1File, w4File] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '../..');
const panels = [w1File, w4File].map(file => JSON.parse(readFileSync(file, 'utf8')));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function rows(result) {
  const entries = Object.entries(result.frameworks).filter(([, f]) => f.median);
  const fastest = Math.min(...entries.map(([, f]) => f.median));
  return entries.map(([id, f]) => ({ id, ...f, ratio: f.median / fastest })).sort((a, b) => a.median - b.median);
}

const notes = result => Object.entries(result.frameworks)
  .filter(([, f]) => f.effectiveWorkers < result.workers)
  .map(([, f]) => `${f.label} runs one spec file at a time: parallel runs need Cypress Cloud`);

const themes = {
  light: { bg: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#59636e', bar: '#8c959f', ours: '#1a7f37', oursBar: '#2da44e' },
  dark: { bg: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#9198a1', bar: '#6e7681', ours: '#3fb950', oursBar: '#2ea043' },
};

function svg(theme) {
  const t = themes[theme];
  const width = 1000, left = 210, barMax = 560, rowHeight = 30, panelGap = 56;
  const panelRows = panels.map(rows);
  const max = Math.max(...panelRows.flat().map(r => r.median));
  const scale = ms => Math.max(3, ms / max * barMax);
  let y = 104;
  let body = '';
  panels.forEach((result, index) => {
    body += `<text x="32" y="${y}" font-size="16" font-weight="700" fill="${t.text}">${result.workers === 1 ? '1 worker' : `${result.workers} workers`}</text>\n`;
    y += 14;
    for (const row of panelRows[index]) {
      const ours = row.id === 'flashwright';
      const color = ours ? t.oursBar : t.bar;
      body += `<text x="${left - 14}" y="${y + 17}" font-size="14" text-anchor="end" fill="${ours ? t.ours : t.text}"${ours ? ' font-weight="700"' : ''}>${esc(row.label)}</text>
<rect x="${left}" y="${y + 5}" width="${scale(row.median).toFixed(1)}" height="16" rx="3" fill="${color}"/>
<text x="${left + scale(row.median) + 8}" y="${y + 18}" font-size="13" fill="${ours ? t.ours : t.muted}"${ours ? ' font-weight="700"' : ''}>${(row.median / 1000).toFixed(2)} s${row.ratio < 1.005 ? '  ·  fastest' : `  ·  ${row.ratio.toFixed(1)}× the fastest`}</text>
`;
      y += rowHeight;
    }
    const extra = notes(result);
    if (extra.length) {
      body += `<text x="${left}" y="${y + 14}" font-size="12" fill="${t.muted}">${esc(extra.join('; '))}</text>\n`;
      y += 20;
    }
    y += index === 0 ? panelGap - 20 : 0;
  });
  const height = y + 56;
  const { iterations, expected, layout } = panels[0];
  const layoutText = layout === 'grouped' ? 'tests grouped by feature in 7 files' : 'one test per file';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">
<rect width="${width}" height="${height}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
<text x="32" y="44" font-size="22" font-weight="700" fill="${t.text}">The same ${expected} TodoMVC tests in ${Object.keys(panels[0].frameworks).length} frameworks</text>
<text x="32" y="70" font-size="14" fill="${t.muted}">Whole test command, median of ${iterations} runs, ${layoutText}. Same machine, same Chromium 156 for every tool. Shorter is faster.</text>
${body}<text x="32" y="${height - 24}" font-size="13" fill="${t.muted}">Every framework passes all ${expected} tests in every counted run. Ports, versions and setup: bench/competitors. Reproduce: sh bench/competitors/run-all.sh</text>
</svg>
`;
}

writeFileSync(resolve(root, 'docs/media/competitors.svg'), svg('light'));
writeFileSync(resolve(root, 'docs/media/competitors-dark.svg'), svg('dark'));

// The landing page's bars, in its own markup.
const sitePath = resolve(root, 'site/index.html');
const site = readFileSync(sitePath, 'utf8');
const start = '<!-- competitors:start -->', end = '<!-- competitors:end -->';
if (site.includes(start)) {
  const html = panels.map(result => {
    const panelRows = rows(result);
    const max = Math.max(...panelRows.map(r => r.median));
    const items = panelRows.map(row => {
      const ours = row.id === 'flashwright';
      return `          <div class="row${ours ? ' ours' : ''}"><div class="name">${esc(row.label)}</div><div class="x">${row.ratio < 1.005 ? 'fastest' : `${row.ratio.toFixed(1)}×`}</div><div class="track"><div class="bar ${ours ? 'fw' : 'pw'}" style="width:${(row.median / max * 70).toFixed(1)}%"><i>${(row.median / 1000).toFixed(2)} s</i></div></div></div>`;
    }).join('\n');
    const extra = notes(result);
    return `        <div class="panel">
          <p class="panel-title">${result.workers === 1 ? '1 worker' : `${result.workers} workers`}</p>
${items}${extra.length ? `\n          <p class="note">${esc(extra.join('; '))}.</p>` : ''}
        </div>`;
  }).join('\n');
  writeFileSync(sitePath, site.slice(0, site.indexOf(start) + start.length) + '\n' + html + '\n        ' + site.slice(site.indexOf(end)));
}
console.log('wrote docs/media/competitors.svg, competitors-dark.svg and the site section');
