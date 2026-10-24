// Complete `test` command wall-clock: stock Playwright vs the Flashwright fork.
// Usage: node bench/run.mjs <todomvc|svgomg> <workers> <iterations> <engine,...>
// An engine can carry environment variables: fork:NAME=value+NAME2=value. USE_<option>=<json>
// sets a test option and CONFIG_<key>=<json> a config property, for example
// fork:USE_instantAnimations=true or fork:CONFIG_testOrder="file" (values cannot contain commas).
// EXTRA_ARGS=<arg arg> adds browser launch arguments, for example fork:EXTRA_ARGS=--single-process.
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applicationCorpusDirectory, loadApplicationCorpus, materializeApplicationTests, startApplicationServer } from './application-corpus.mjs';
import { startWorkloadServer, workloadSpec } from './workloads/server.mjs';
import { startShopServer } from './apps/shop/server.mjs';
import { cp } from 'node:fs/promises';

const [app = 'todomvc', workersArg = '1', iterationsArg = '3', enginesArg = 'stock,fork'] = process.argv.slice(2);
const workers = Number(workersArg), iterations = Number(iterationsArg), engines = enginesArg.split(',');
const root = resolve('.');
const node = process.env.NODE_BIN ?? join(root, '.tools/node-v24.15.0-linux-x64/bin/node');
const stockTest = resolve('workbench/pw-stock/node_modules/@playwright/test');
const forkTest = resolve(process.env.FORK_DIR ?? '.', 'packages/playwright-test');
const engineDefinitions = {
  stock: { pkg: join(stockTest, 'index.mjs'), cli: join(stockTest, 'cli.js') },
  fork: { pkg: join(forkTest, 'index.mjs'), cli: join(forkTest, 'cli.js') },
};
const base = resolve('workbench/bench-runs', `${app.replace(':', '-')}-w${workers}`);
await rm(base, { recursive: true, force: true });
// `workload:<name>` runs a generated 15-test suite against the workload fixture; anything else is an app corpus.
const workload = app.startsWith('workload:') ? app.slice('workload:'.length) : undefined;
// `shop` is a realistic app suite: setup project with saved auth, fullyParallel, API latency.
const shop = app === 'shop';
const corpus = workload || shop ? undefined : await loadApplicationCorpus(applicationCorpusDirectory(app));
const server = shop ? await startShopServer() : workload ? await startWorkloadServer() : await startApplicationServer(corpus);

const projects = {};
for (const engine of engines) {
  const [name, ...variantParts] = engine.split(':');
  const variant = variantParts.join(':');
  const definition = engineDefinitions[name];
  const project = join(base, engine.replace(':', '-'));
  await mkdir(project, { recursive: true });
  const adapter = join(project, 'adapter.mjs');
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
  // BENCH_CHROME_TRACE=<dir> records a Chromium trace of each worker's browser into <dir> (read it
  // with chrome-trace.py); BENCH_CHROME_TRACE_CATEGORIES=<a,b> replaces the default categories.
  const chromeTrace = process.env.BENCH_CHROME_TRACE;
  const traceCategories = process.env.BENCH_CHROME_TRACE_CATEGORIES?.split(',') ?? ['toplevel', 'mojom', 'devtools', 'v8', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'viz', 'gpu', 'loading', 'navigation', 'ipc', 'net'];
  await writeFile(adapter, chromeTrace ? `import { test as base } from ${JSON.stringify(definition.pkg)};
import fs from 'node:fs';
export { expect, defineConfig } from ${JSON.stringify(definition.pkg)};
export const test = base.extend({
  _chromeTrace: [async ({ browser }, use, workerInfo) => {
    await browser.startTracing(undefined, { categories: ${JSON.stringify(traceCategories)} });
    await use();
    fs.mkdirSync(${JSON.stringify(resolve(chromeTrace))}, { recursive: true });
    fs.writeFileSync(${JSON.stringify(resolve(chromeTrace))} + '/' + Date.now() + '-w' + workerInfo.workerIndex + '.json', await browser.stopTracing());
  }, { scope: 'worker', auto: true }],
});
` : `export { test, expect, defineConfig } from ${JSON.stringify(definition.pkg)};\n`);
  if (shop) {
    await cp(join(import.meta.dirname, 'apps/shop/tests'), join(project, 'tests'), { recursive: true });
  } else if (workload) {
    await mkdir(join(project, 'tests'), { recursive: true });
    await writeFile(join(project, 'tests', `${workload}.spec.ts`), workloadSpec(workload, 15));
  } else {
    await materializeApplicationTests(corpus, project, adapter);
  }
  const config = { testDir: './tests', workers, retries: 0, fullyParallel: false, timeout: 30000, expect: { timeout: 5000 },
    reporter: [['json', { outputFile: join(project, 'report.json') }], ...(process.env.HTML_REPORT ? [['html', { open: 'never', outputFolder: join(project, 'html-report') }]] : []), ...(process.env.STEPS ? [[resolve(import.meta.dirname, 'step-reporter.cjs')], [resolve(import.meta.dirname, 'step-tree-reporter.cjs')], [resolve(import.meta.dirname, 'worker-timeline.cjs')]] : [])],
    outputDir: join(project, 'results'),
    use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off', video: 'off', screenshot: 'off' } };
  if (shop) {
    Object.assign(config, { fullyParallel: true, projects: [
      { name: 'setup', testMatch: /.*\.setup\.ts/.source },
      { name: 'chromium', dependencies: ['setup'], use: { storageState: 'auth.json' } },
    ] });
  }
  // The config stays byte-identical across runs, like a real project's, so the transform cache
  // hits; the app URL comes from the environment.
  await writeFile(join(project, 'runner.config.mjs'), `import { defineConfig } from './adapter.mjs'; const config = ${JSON.stringify(config)}; if (config.projects) config.projects[0].testMatch = new RegExp(config.projects[0].testMatch); if (process.env.BENCH_BASE_URL) config.use.baseURL = process.env.BENCH_BASE_URL; if (process.env.EXTRA_ARGS) config.use.launchOptions = { args: process.env.EXTRA_ARGS.split(' ') }; for (const [key, value] of Object.entries(process.env)) { if (key.startsWith('USE_')) config.use[key.slice(4)] = JSON.parse(value); if (key.startsWith('CONFIG_')) config[key.slice(7)] = JSON.parse(value); } export default defineConfig(config);\n`);
  projects[engine] = { project, definition, variant };
}

async function runOnce(engine, extraArgs = []) {
  const { project, definition, variant } = projects[engine];
  await rm(join(project, 'report.json'), { force: true });
  // The warm session keeps working after a run, also during the next engine's run: it is measured
  // on its own, as the engine variant FLASHWRIGHT_SESSION=1.
  const env = { FLASHWRIGHT_SESSION: '0', ...process.env, FLASHWRIGHT_APPLICATION_URL: server.url, FORCE_COLOR: '0', STEP_OUT: join(project, 'steps.txt'), ...(workload || shop ? { BENCH_BASE_URL: server.url } : {}) };
  for (const assignment of variant.split('+').filter(Boolean)) { const [k, ...v] = assignment.split('='); env[k] = v.length ? v.join('=') : '1'; }
  // The step reporters read the start time from a file: a variable that changes on every run would
  // keep a warm session (FLASHWRIGHT_SESSION) from matching the next run.
  if (process.env.STEPS)
    await writeFile(join(project, 'steps.txt.t0'), String(Date.now()));
  const started = performance.now();
  // BENCH_CPU=1 reports user+sys CPU of the whole process tree (bash `time` waits for all descendants).
  // BENCH_TIMELINE=<dir> records every run's output lines with the time they arrived, using the
  // list reporter, for the side-by-side replay (bench/media/race.mjs).
  const timeline = process.env.BENCH_TIMELINE;
  // BENCH_ARGS adds arguments to the test command, for example one test file to run.
  const benchArgs = process.env.BENCH_ARGS ? process.env.BENCH_ARGS.split(' ') : [];
  const command = [node, definition.cli, 'test', '--config', join(project, 'runner.config.mjs'), ...(timeline ? ['--reporter=list'] : []), ...benchArgs, ...extraArgs];
  // BENCH_PROCCPU=1 prints CPU time by process kind (node main/worker, browser, renderer, ...);
  // BENCH_PROCCPU=system counts every process on the machine, a warm session's included.
  const child = process.env.BENCH_CPU
    ? spawn('bash', ['-c', `TIMEFORMAT='CPUTIME %U %S'; time ${command.map(a => `'${a}'`).join(' ')}`], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : process.env.BENCH_PROCCPU
      ? spawn('python3', [resolve(import.meta.dirname, { threads: 'thread-cpu.py', system: 'system-cpu.py' }[process.env.BENCH_PROCCPU] ?? 'proc-cpu.py'), ...command], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command[0], command.slice(1), { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const lines = [];
  let pending = '';
  child.stdout.on('data', c => {
    output += c;
    pending += c;
    const parts = pending.split('\n');
    pending = parts.pop();
    for (const line of parts)
      lines.push({ t: Math.round(performance.now() - started), line });
  });
  child.stderr.on('data', c => { output += c; });
  const code = await new Promise(r => child.on('close', r));
  const elapsed = performance.now() - started;
  if (timeline) {
    await mkdir(timeline, { recursive: true });
    await writeFile(join(timeline, `${engine.replace(/[^\w-]/g, '_')}-${Date.now()}.json`), JSON.stringify({ engine, elapsed, lines }));
  }
  let stats = {};
  try { stats = JSON.parse(await readFile(join(project, 'report.json'), 'utf8')).stats ?? {}; } catch {}
  if (code !== 0 && workload !== 'failure' && workload !== 'broken') console.error(`[${engine}] exit ${code}\n${output.slice(-4000)}`);
  if (process.env.BENCH_PROCCPU) console.log(`[${engine}] CPU by process kind:\n${output}`);
  // BENCH_OUTPUT=1 prints every run's output, for timing logs added while profiling.
  if (process.env.BENCH_OUTPUT) console.log(`[${engine}] output:\n${output}`);
  const cpu = /CPUTIME ([\d.]+) ([\d.]+)/.exec(output);
  return { elapsed, code, expected: stats.expected, unexpected: stats.unexpected, cpu: cpu ? (Number(cpu[1]) + Number(cpu[2])) * 1000 : undefined };
}

const results = Object.fromEntries(engines.map(e => [e, []]));
try {
  // Visual baselines come from the first engine, untimed, and every engine compares against
  // the same files, as a project switching engines would.
  if (workload === 'screenshot') {
    const first = projects[engines[0]].project;
    await runOnce(engines[0], ['--update-snapshots']);
    for (const engine of engines.slice(1))
      await cp(join(first, 'tests', 'screenshot.spec.ts-snapshots'), join(projects[engine].project, 'tests', 'screenshot.spec.ts-snapshots'), { recursive: true });
  }
  for (let i = 0; i < iterations; i++) {
    const order = i % 2 ? [...engines].reverse() : engines;
    for (const engine of order) {
      // BENCH_PAUSE=<ms> waits before each run, untimed, like an agent that edits between runs.
      if (process.env.BENCH_PAUSE)
        await new Promise(resolve => setTimeout(resolve, Number(process.env.BENCH_PAUSE)));
      const r = await runOnce(engine);
      const busy = server.takeBusyTime?.();
      results[engine].push({ ...r, busy });
      console.log(`${app} w${workers} #${i} ${engine.padEnd(28)} ${r.elapsed.toFixed(0).padStart(6)} ms  exit=${r.code} pass=${r.expected} fail=${r.unexpected}${r.cpu !== undefined ? `  cpu=${r.cpu.toFixed(0)}ms` : ''}${busy !== undefined ? `  api-busy=${busy.toFixed(0)}ms` : ''}`);
    }
  }
} finally { await server.close(); }
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const reference = median(results[engines[0]].map(r => r.elapsed));
for (const engine of engines) {
  const m = median(results[engine].map(r => r.elapsed));
  const busy = results[engine][0].busy !== undefined ? `  api-busy ${median(results[engine].map(r => r.busy)).toFixed(0)} ms` : '';
  console.log(`SUMMARY ${app} w${workers} ${engine.padEnd(28)} median ${m.toFixed(0).padStart(6)} ms  ${engines[0]}/this = ${(reference / m).toFixed(3)}x${busy}`);
}
