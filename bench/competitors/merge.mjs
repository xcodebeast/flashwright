// Pools run.mjs results of the same layout and worker count (runs split over several invocations):
//   node bench/competitors/merge.mjs <output.json> <result.json>...
import { readFileSync, writeFileSync } from 'node:fs';

const [output, ...inputs] = process.argv.slice(2);
const results = inputs.map(file => JSON.parse(readFileSync(file, 'utf8')));
const [first] = results;
for (const result of results) {
  if (result.layout !== first.layout || result.workers !== first.workers)
    throw new Error(`Cannot merge ${result.layout}/w${result.workers} with ${first.layout}/w${first.workers}`);
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const merged = { ...first, date: results.map(result => result.date).sort().at(-1), frameworks: {} };
for (const framework of Object.keys(first.frameworks)) {
  const runs = results.flatMap(result => result.frameworks[framework]?.runs ?? []);
  const ok = runs.filter(run => run.ok).map(run => run.ms);
  merged.frameworks[framework] = { ...first.frameworks[framework], runs, median: ok.length ? median(ok) : null, failed: runs.length - ok.length };
}
merged.iterations = Math.min(...Object.values(merged.frameworks).map(framework => framework.runs.length));
writeFileSync(output, JSON.stringify(merged, null, 2));
for (const [framework, result] of Object.entries(merged.frameworks))
  console.log(`${framework.padEnd(12)} ${String(result.median).padStart(6)} ms  ${result.runs.length} runs${result.failed ? `, ${result.failed} failed` : ''}`);
