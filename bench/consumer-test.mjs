// Drop-in check: installs this fork's packed packages into a fresh project in place of
// @playwright/test and runs the unmodified upstream TodoMVC suite with a TypeScript config.
// Usage: node bench/consumer-test.mjs [--npm]
// --npm installs the flashwright-* packages that utils/flashwright/pack.mjs made (run it first),
// under their npm names, the way `npm i -D @playwright/test@npm:flashwright-test@<version>` would.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applicationCorpusDirectory, loadApplicationCorpus, startApplicationServer } from './application-corpus.mjs';

const root = resolve(import.meta.dirname, '..');
const work = resolve(root, 'workbench/consumer');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'packs'), { recursive: true });

const packs = {};
if (process.argv.includes('--npm')) {
  const { tarballs } = JSON.parse(readFileSync(join(root, 'workbench/npm/tarballs.json'), 'utf8'));
  packs['playwright-core'] = tarballs['flashwright-core'];
  packs['playwright'] = tarballs['flashwright'];
  packs['playwright-test'] = tarballs['flashwright-test'];
} else {
  for (const name of ['playwright-core', 'playwright', 'playwright-test']) {
    const file = execFileSync('npm', ['pack', '--pack-destination', join(work, 'packs')], { cwd: join(root, 'packages', name), encoding: 'utf8' }).trim().split('\n').pop();
    packs[name] = join(work, 'packs', file);
  }
}

const project = join(work, 'project');
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({
  name: 'consumer', private: true,
  devDependencies: { '@playwright/test': `file:${packs['playwright-test']}` },
  overrides: { 'playwright': `file:${packs['playwright']}`, 'playwright-core': `file:${packs['playwright-core']}` },
}, null, 2));
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--offline'], { cwd: project, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });

// The original upstream example tests import '@playwright/test' and visit the public demo; only the URL changes.
cpSync(join(applicationCorpusDirectory('todomvc'), 'tests'), join(project, 'tests'), { recursive: true });
const fixtures = join(project, 'tests', 'fixtures.ts');
const corpus = await loadApplicationCorpus(applicationCorpusDirectory('todomvc'));
const server = await startApplicationServer(corpus);
writeFileSync(fixtures, readFileSync(fixtures, 'utf8').replace('https://demo.playwright.dev/todomvc', server.url));
writeFileSync(join(project, 'playwright.config.ts'), `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: { trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`);
// The app server runs in this process, so the test run must not block the event loop.
const started = performance.now();
const child = spawn('npx', ['playwright', 'test'], { cwd: project });
let output = '';
child.stdout.on('data', chunk => output += chunk);
child.stderr.on('data', chunk => output += chunk);
const status = await new Promise(f => child.on('close', f));
await server.close();
console.log(output.split('\n').slice(-6).join('\n'));
console.log(`exit=${status} in ${(performance.now() - started).toFixed(0)} ms; installed: ${readdirSync(join(project, 'node_modules')).join(', ')}`);
process.exitCode = status ?? 1;
