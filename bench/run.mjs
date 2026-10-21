// Complete `test` command wall-clock: stock Playwright vs the Flashwright fork.
// Usage: node bench/run.mjs <todomvc|svgomg> <workers> <iterations> <engine,...>
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
  const [name, variant = ''] = engine.split(':');
  const definition = engineDefinitions[name];
  const project = join(base, engine.replace(':', '-'));
  await mkdir(project, { recursive: true });
  const adapter = join(project, 'adapter.mjs');
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(adapter, `export { test, expect, defineConfig } from ${JSON.stringify(definition.pkg)};\n`);
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
    use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off', video: 'off', screenshot: 'off', ...(workload ? { baseURL: server.url } : {}), ...(process.env.EXTRA_ARGS ? { launchOptions: { args: process.env.EXTRA_ARGS.split(' ') } } : {}) } };
  if (shop) {
    Object.assign(config, { fullyParallel: true, projects: [
      { name: 'setup', testMatch: /.*\.setup\.ts/.source },
      { name: 'chromium', dependencies: ['setup'], use: { storageState: 'auth.json' } },
    ] });
    config.use.baseURL = server.url;
  }
  await writeFile(join(project, 'runner.config.mjs'), `import { defineConfig } from './adapter.mjs'; const config = ${JSON.stringify(config)}; if (config.projects) config.projects[0].testMatch = new RegExp(config.projects[0].testMatch); export default defineConfig(config);\n`);
  projects[engine] = { project, definition, variant };
}

async function runOnce(engine) {
  const { project, definition, variant } = projects[engine];
  await rm(join(project, 'report.json'), { force: true });
  const env = { ...process.env, FLASHWRIGHT_APPLICATION_URL: server.url, FORCE_COLOR: '0', STEP_OUT: join(project, 'steps.txt') };
  for (const assignment of variant.split('+').filter(Boolean)) { const [k, v = '1'] = assignment.split('='); env[k] = v; }
  env.BENCH_T0 = String(Date.now());
  const started = performance.now();
  // BENCH_CPU=1 reports user+sys CPU of the whole process tree (bash `time` waits for all descendants).
  const command = [node, definition.cli, 'test', '--config', join(project, 'runner.config.mjs')];
  // BENCH_PROCCPU=1 prints CPU time by process kind (node main/worker, browser, renderer, ...).
  const child = process.env.BENCH_CPU
    ? spawn('bash', ['-c', `TIMEFORMAT='CPUTIME %U %S'; time ${command.map(a => `'${a}'`).join(' ')}`], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : process.env.BENCH_PROCCPU
      ? spawn('python3', [resolve(import.meta.dirname, 'proc-cpu.py'), ...command], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command[0], command.slice(1), { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const code = await new Promise(r => child.on('close', r));
  const elapsed = performance.now() - started;
  let stats = {};
  try { stats = JSON.parse(await readFile(join(project, 'report.json'), 'utf8')).stats ?? {}; } catch {}
  if (code !== 0 && workload !== 'failure') console.error(`[${engine}] exit ${code}\n${output.slice(-4000)}`);
  if (process.env.BENCH_PROCCPU) console.log(`[${engine}] CPU by process kind:\n${output}`);
  const cpu = /CPUTIME ([\d.]+) ([\d.]+)/.exec(output);
  return { elapsed, code, expected: stats.expected, unexpected: stats.unexpected, cpu: cpu ? (Number(cpu[1]) + Number(cpu[2])) * 1000 : undefined };
}

const results = Object.fromEntries(engines.map(e => [e, []]));
try {
  for (let i = 0; i < iterations; i++) {
    const order = i % 2 ? [...engines].reverse() : engines;
    for (const engine of order) {
      const r = await runOnce(engine);
      results[engine].push(r);
      console.log(`${app} w${workers} #${i} ${engine.padEnd(28)} ${r.elapsed.toFixed(0).padStart(6)} ms  exit=${r.code} pass=${r.expected} fail=${r.unexpected}${r.cpu !== undefined ? `  cpu=${r.cpu.toFixed(0)}ms` : ''}`);
    }
  }
} finally { await server.close(); }
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const reference = median(results[engines[0]].map(r => r.elapsed));
for (const engine of engines) {
  const m = median(results[engine].map(r => r.elapsed));
  console.log(`SUMMARY ${app} w${workers} ${engine.padEnd(28)} median ${m.toFixed(0).padStart(6)} ms  ${engines[0]}/this = ${(reference / m).toFixed(3)}x`);
}
