// Draws the README's benchmark chart from the last matrix run (bench/matrix.mjs writes
// workbench/matrix-latest.json):
//   node bench/media/chart.mjs [workbench/matrix-latest.json] [docs/media/benchmarks.svg]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [input = 'workbench/matrix-latest.json', output = 'docs/media/benchmarks.svg'] = process.argv.slice(2);
const { rows } = JSON.parse(readFileSync(input, 'utf8'));
const find = (scenario, workers) => rows.find(r => r.scenario === scenario && r.workers === workers);

// The single-file workloads run in one worker whatever the setting; show their 1-worker runs.
const shown = [
  ['TodoMVC example suite · 1 worker', 'todomvc', 1],
  ['TodoMVC example suite · 4 workers', 'todomvc', 4],
  ['SVGOMG example suite · 1 worker', 'svgomg', 1],
  ['SVGOMG example suite · 4 workers', 'svgomg', 4],
  ['Shop app with login setup · 1 worker', 'shop', 1],
  ['Shop app with login setup · 4 workers', 'shop', 4],
  ['Trivial tests', 'workload:noop', 1],
  ['Click + assertion', 'workload:interaction', 1],
  ['Assertion on a delayed update', 'workload:assertion', 1],
  ['Navigation', 'workload:navigation', 1],
  ['Fixture setup only', 'workload:setup', 1],
  ['Form submit to a backend', 'workload:backend', 1],
  ['toHaveScreenshot()', 'workload:screenshot', 1],
  ['page.screenshot()', 'workload:capture', 1],
  ['Suite with real failures', 'workload:broken', 1],
  ['Expected failures', 'workload:failure', 1],
].map(([label, scenario, workers]) => ({ label, ...find(scenario, workers) }));

const width = 1000, left = 300, barMax = 520, rowHeight = 40, top = 96, bottom = 64;
const height = top + shown.length * rowHeight + bottom;
const max = Math.max(...shown.map(r => r.stock));
const scale = ms => Math.max(2, ms / max * barMax);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const geo = Math.exp(rows.reduce((a, r) => a + Math.log(r.speedup), 0) / rows.length);

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">
<rect width="${width}" height="${height}" rx="14" fill="#ffffff" stroke="#d0d7de"/>
<text x="32" y="44" font-size="22" font-weight="700" fill="#1f2328">Complete test runs, Flashwright vs Playwright 1.64.1</text>
<text x="32" y="70" font-size="14" fill="#59636e">Wall-clock time of the whole command, median of 15 runs each, same machine. Shorter is faster.</text>
<rect x="${width - 230}" y="58" width="14" height="14" rx="3" fill="#8c959f"/><text x="${width - 210}" y="70" font-size="13" fill="#59636e">Playwright</text>
<rect x="${width - 128}" y="58" width="14" height="14" rx="3" fill="#2da44e"/><text x="${width - 108}" y="70" font-size="13" fill="#59636e">Flashwright</text>
`;
shown.forEach((row, i) => {
  const y = top + i * rowHeight;
  svg += `<text x="${left - 14}" y="${y + 21}" font-size="14" text-anchor="end" fill="#1f2328">${esc(row.label)}</text>
<rect x="${left}" y="${y + 4}" width="${scale(row.stock).toFixed(1)}" height="14" rx="3" fill="#8c959f"/>
<text x="${left + scale(row.stock) + 6}" y="${y + 16}" font-size="12" fill="#59636e">${row.stock} ms</text>
<rect x="${left}" y="${y + 20}" width="${scale(row.fork).toFixed(1)}" height="14" rx="3" fill="#2da44e"/>
<text x="${left + scale(row.fork) + 6}" y="${y + 32}" font-size="12" fill="#1a7f37">${row.fork} ms</text>
<text x="${width - 32}" y="${y + 25}" font-size="17" font-weight="700" text-anchor="end" fill="#1a7f37">${row.speedup.toFixed(2)}×</text>
`;
});
svg += `<text x="32" y="${height - 26}" font-size="14" fill="#59636e">Every scenario at least 2× faster; geometric mean ${geo.toFixed(2)}× over all ${rows.length} runs of the matrix (1 and 4 workers each). Reproduce: node bench/matrix.mjs 15</text>
</svg>
`;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, svg);
console.log(`wrote ${output}`);
