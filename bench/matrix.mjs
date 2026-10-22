// Runs every scenario through bench/run.mjs and prints a stock/fork table.
// Usage: node bench/matrix.mjs [iterations] [workers,...] [scenario,...]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [iterations = '3', workersArg = '1,4', scenariosArg] = process.argv.slice(2);
const scenarios = scenariosArg?.split(',') ?? ['todomvc', 'svgomg', 'shop', ...['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure', 'broken', 'screenshot', 'capture'].map(w => `workload:${w}`)];
// Time the tests themselves ask to wait, which no framework can remove: the app's own delays and
// the app server's response time (for the shop, the wall time during which at least one API
// request was pending, measured in each engine's own runs). For these scenarios the comparison
// that measures the framework is wall time minus this floor. Assertion timeouts that are meant to
// expire are not a floor: Flashwright's failFastWhenIdle ends them once nothing can change the page.
const floors = {
  'workload:backend': () => 15 * 20,
  'workload:assertion': () => 15 * 8,
  'shop': busy => busy,
};
const rows = [];
for (const scenario of scenarios) {
  for (const workers of workersArg.split(',')) {
    const result = spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, scenario, workers, iterations, 'stock,fork'], { encoding: 'utf8', env: process.env });
    const summaries = [...result.stdout.matchAll(/SUMMARY \S+ w\d+ (\S+)\s+median\s+(\d+) ms.*?(?:api-busy (\d+) ms)?$/gm)];
    const medians = Object.fromEntries(summaries.map(m => [m[1], Number(m[2])]));
    const busy = Object.fromEntries(summaries.map(m => [m[1], Number(m[3] ?? 0)]));
    const row = { scenario, workers: Number(workers), stock: medians.stock, fork: medians.fork, speedup: medians.stock / medians.fork };
    const floor = floors[scenario];
    if (floor) {
      row.stockFramework = row.stock - floor(busy.stock);
      row.forkFramework = row.fork - floor(busy.fork);
      row.frameworkSpeedup = row.stockFramework / row.forkFramework;
    }
    rows.push(row);
    const framework = floor ? `  framework: stock ${String(row.stockFramework).padStart(5)} ms  fork ${String(row.forkFramework).padStart(5)} ms  ${row.frameworkSpeedup.toFixed(2)}x` : '';
    console.log(`${scenario.padEnd(22)} w${workers}  stock ${String(row.stock).padStart(6)} ms  fork ${String(row.fork).padStart(6)} ms  ${row.speedup.toFixed(2)}x${framework}`);
    if (!medians.fork)
      console.log(result.stdout.slice(-2000), result.stderr.slice(-2000));
  }
}
const atLeast2x = rows.filter(r => r.speedup >= 2).length;
const geo = Math.exp(rows.reduce((a, r) => a + Math.log(r.speedup), 0) / rows.length);
const best = r => Math.max(r.speedup, r.frameworkSpeedup ?? 0);
const bestAtLeast2x = rows.filter(r => best(r) >= 2).length;
console.log(`\n${atLeast2x}/${rows.length} cells at >= 2x wall time; geometric mean ${geo.toFixed(2)}x`);
console.log(`${bestAtLeast2x}/${rows.length} cells at >= 2x on wall time or, for wait-bound scenarios, framework time`);
writeFileSync(new URL('../workbench/matrix-latest.json', import.meta.url), JSON.stringify({ date: new Date().toISOString(), rows }, null, 2));
