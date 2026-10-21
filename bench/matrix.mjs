// Runs every scenario through bench/run.mjs and prints a stock/fork table.
// Usage: node bench/matrix.mjs [iterations] [workers,...] [scenario,...]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [iterations = '3', workersArg = '1,4', scenariosArg] = process.argv.slice(2);
const scenarios = scenariosArg?.split(',') ?? ['todomvc', 'svgomg', 'shop', ...['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure'].map(w => `workload:${w}`)];
const rows = [];
for (const scenario of scenarios) {
  for (const workers of workersArg.split(',')) {
    const result = spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, scenario, workers, iterations, 'stock,fork'], { encoding: 'utf8', env: process.env });
    const medians = Object.fromEntries([...result.stdout.matchAll(/SUMMARY \S+ w\d+ (\S+)\s+median\s+(\d+) ms/g)].map(m => [m[1], Number(m[2])]));
    const row = { scenario, workers: Number(workers), stock: medians.stock, fork: medians.fork, speedup: medians.stock / medians.fork };
    rows.push(row);
    console.log(`${scenario.padEnd(22)} w${workers}  stock ${String(row.stock).padStart(6)} ms  fork ${String(row.fork).padStart(6)} ms  ${row.speedup.toFixed(2)}x`);
    if (!medians.fork)
      console.log(result.stdout.slice(-2000), result.stderr.slice(-2000));
  }
}
const atLeast2x = rows.filter(r => r.speedup >= 2).length;
const geo = Math.exp(rows.reduce((a, r) => a + Math.log(r.speedup), 0) / rows.length);
console.log(`\n${atLeast2x}/${rows.length} cells at >= 2x; geometric mean ${geo.toFixed(2)}x`);
writeFileSync(new URL('../workbench/matrix-latest.json', import.meta.url), JSON.stringify({ date: new Date().toISOString(), rows }, null, 2));
