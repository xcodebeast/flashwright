// Complete `test` command wall-clock: stock Playwright vs the Flashwright fork.
// Usage: node bench/run.mjs <todomvc|svgomg> <workers> <iterations> <engine,...>
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applicationCorpusDirectory, loadApplicationCorpus, materializeApplicationTests, startApplicationServer } from './application-corpus.mjs';

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
const base = resolve('workbench/bench-runs', `${app}-w${workers}`);
await rm(base, { recursive: true, force: true });
const corpus = await loadApplicationCorpus(applicationCorpusDirectory(app));
const server = await startApplicationServer(corpus);

const projects = {};
for (const engine of engines) {
  const [name, variant = ''] = engine.split(':');
  const definition = engineDefinitions[name];
  const project = join(base, engine.replace(':', '-'));
  await mkdir(project, { recursive: true });
  const adapter = join(project, 'adapter.mjs');
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(adapter, `export { test, expect, defineConfig } from ${JSON.stringify(definition.pkg)};\n`);
  await materializeApplicationTests(corpus, project, adapter);
  const config = { testDir: './tests', workers, retries: 0, fullyParallel: false, timeout: 30000, expect: { timeout: 5000 },
    reporter: [['json', { outputFile: join(project, 'report.json') }], ...(process.env.STEPS ? [[resolve(import.meta.dirname, 'step-reporter.cjs')]] : [])],
    outputDir: join(project, 'results'),
    use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off', video: 'off', screenshot: 'off' } };
  await writeFile(join(project, 'runner.config.mjs'), `import { defineConfig } from './adapter.mjs'; export default defineConfig(${JSON.stringify(config)});\n`);
  projects[engine] = { project, definition, variant };
}

async function runOnce(engine) {
  const { project, definition, variant } = projects[engine];
  await rm(join(project, 'report.json'), { force: true });
  const env = { ...process.env, FLASHWRIGHT_APPLICATION_URL: server.url, FORCE_COLOR: '0', STEP_OUT: join(project, 'steps.txt') };
  for (const assignment of variant.split('+').filter(Boolean)) { const [k, v = '1'] = assignment.split('='); env[k] = v; }
  const started = performance.now();
  const child = spawn(node, [definition.cli, 'test', '--config', join(project, 'runner.config.mjs')], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const code = await new Promise(r => child.on('close', r));
  const elapsed = performance.now() - started;
  let stats = {};
  try { stats = JSON.parse(await readFile(join(project, 'report.json'), 'utf8')).stats ?? {}; } catch {}
  if (code !== 0) console.error(`[${engine}] exit ${code}\n${output.slice(-4000)}`);
  return { elapsed, code, expected: stats.expected, unexpected: stats.unexpected };
}

const results = Object.fromEntries(engines.map(e => [e, []]));
try {
  for (let i = 0; i < iterations; i++) {
    const order = i % 2 ? [...engines].reverse() : engines;
    for (const engine of order) {
      const r = await runOnce(engine);
      results[engine].push(r);
      console.log(`${app} w${workers} #${i} ${engine.padEnd(28)} ${r.elapsed.toFixed(0).padStart(6)} ms  exit=${r.code} pass=${r.expected} fail=${r.unexpected}`);
    }
  }
} finally { await server.close(); }
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const reference = median(results[engines[0]].map(r => r.elapsed));
for (const engine of engines) {
  const m = median(results[engine].map(r => r.elapsed));
  console.log(`SUMMARY ${app} w${workers} ${engine.padEnd(28)} median ${m.toFixed(0).padStart(6)} ms  ${engines[0]}/this = ${(reference / m).toFixed(3)}x`);
}
