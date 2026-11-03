// Complete test runs of the same TodoMVC suite in every framework, on the same Chromium.
// Usage: node bench/competitors/run.mjs <workers> <iterations> [framework,...]
// Each iteration runs every framework once, starting at a different framework each time; a run
// counts only when it exits cleanly with all 24 tests passed. Results go to
// workbench/competitors/<date>-w<workers>.json for chart.mjs.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applicationCorpusDirectory, loadApplicationCorpus, startApplicationServer } from '../application-corpus.mjs';
import { frameworks as allFrameworks, generate, layout, loadAdapter } from './generate.mjs';
import { scenarios } from './scenarios.mjs';

const [workersArg = '1', iterationsArg = '5', frameworksArg] = process.argv.slice(2);
const workers = Number(workersArg), iterations = Number(iterationsArg);
const frameworks = frameworksArg?.split(',') ?? allFrameworks;
const root = resolve(import.meta.dirname, '../..');
const node = process.env.NODE_BIN ?? process.execPath;
const bun = process.env.BUN_BIN ?? 'bun';
const env = {
  CHROME_PATH: process.env.CHROME_PATH ?? join(process.env.HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  CHROMEDRIVER_PATH: process.env.CHROMEDRIVER_PATH ?? join(import.meta.dirname, 'chromedriver/node_modules/chromedriver/lib/chromedriver/chromedriver'),
  WORKERS: String(workers),
  CI: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
};

const adapters = {};
for (const framework of frameworks) {
  await generate(framework);
  adapters[framework] = await loadAdapter(framework);
}

const corpus = await loadApplicationCorpus(applicationCorpusDirectory('todomvc'));
const server = await startApplicationServer(corpus);
const expected = scenarios.length;

function runOnce(framework) {
  const adapter = adapters[framework];
  const runEnv = { ...env, APP_URL: server.url };
  const { command, args, env: extraEnv } = adapter.command({ workers, node, bun, env: runEnv });
  return new Promise(resolvePromise => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: join(import.meta.dirname, framework),
      env: { ...process.env, ...runEnv, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('close', code => {
      const ms = Math.round(performance.now() - started);
      const passed = adapter.passed(output);
      resolvePromise({ ms, code, passed, ok: code === 0 && passed === expected, output });
    });
  });
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const runs = Object.fromEntries(frameworks.map(framework => [framework, []]));
const date = new Date().toISOString();
const directory = join(root, 'workbench/competitors');
await mkdir(directory, { recursive: true });
const file = join(directory, `${date.replace(/[:.]/g, '-')}-${layout}-w${workers}.json`);

// Written after every iteration, so an interrupted run keeps what it measured; merge.mjs pools files.
async function saveResults() {
  const results = { date, layout, workers, iterations: Math.max(...frameworks.map(framework => runs[framework].length)), expected, chrome: env.CHROME_PATH, frameworks: {} };
  for (const framework of frameworks) {
    const adapter = adapters[framework];
    const okRuns = runs[framework].filter(run => run.ok).map(run => run.ms);
    results.frameworks[framework] = { label: adapter.label, package: adapter.package, kind: adapter.kind, effectiveWorkers: Math.min(workers, adapter.maxWorkers ?? workers), runs: runs[framework].map(({ ms, ok, passed }) => ({ ms, ok, passed })), median: okRuns.length ? median(okRuns) : null, failed: runs[framework].length - okRuns.length };
  }
  await writeFile(file, JSON.stringify(results, null, 2));
  return results;
}

for (let iteration = 0; iteration < iterations; iteration++) {
  const order = frameworks.map((_, index) => frameworks[(index + iteration) % frameworks.length]);
  for (const framework of order) {
    const run = await runOnce(framework);
    runs[framework].push(run);
    console.log(`${iteration + 1}/${iterations} ${framework.padEnd(12)} ${String(run.ms).padStart(6)} ms  ${run.ok ? 'ok' : `FAILED (exit ${run.code}, ${run.passed}/${expected} passed)`}`);
    if (!run.ok && process.env.BENCH_VERBOSE)
      console.log(run.output);
  }
  await saveResults();
}
await server.close();

const results = await saveResults();
console.log(`\nlayout=${layout}, workers=${workers}, ${iterations} runs each, median wall-clock of the complete test command`);
for (const [framework, result] of Object.entries(results.frameworks))
  console.log(`${result.label.padEnd(24)} ${result.median ? `${String(result.median).padStart(6)} ms` : '     -   '}${result.failed ? `  FAILED ${result.failed}/${runs[framework].length} runs` : ''}`);
console.log(`\n${file}`);
