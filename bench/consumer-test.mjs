// Drop-in check: installs this fork's packed packages into a fresh project in place of
// @playwright/test and runs the unmodified upstream TodoMVC suite with a TypeScript config, on
// Node and, when it is installed, on Bun.
// Usage: node bench/consumer-test.mjs [--npm | --registry]
// --npm installs the flashwright-* packages that utils/flashwright/pack.mjs made (run it first),
// under their npm names, the way `npm i -D @playwright/test@npm:flashwright-test@<version>` would.
// --registry installs the published packages from npm with exactly that command.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applicationCorpusDirectory, loadApplicationCorpus, startApplicationServer } from './application-corpus.mjs';

const root = resolve(import.meta.dirname, '..');
// Outside the repository, like a real project: Bun would otherwise apply the repository's tsconfig paths.
const work = join(tmpdir(), 'flashwright-consumer');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'packs'), { recursive: true });

const registry = process.argv.includes('--registry');
const packs = {};
if (registry) {
  // Nothing to pack: the project installs from npm below.
} else if (process.argv.includes('--npm')) {
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
if (registry) {
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true }, null, 2));
  execFileSync('npm', ['install', '-D', '@playwright/test@npm:flashwright-test', '--no-audit', '--no-fund', '--prefer-online'], { cwd: project, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
  console.log(readFileSync(join(project, 'package.json'), 'utf8'));
} else {
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'consumer', private: true,
    devDependencies: { '@playwright/test': `file:${packs['playwright-test']}` },
    overrides: { 'playwright': `file:${packs['playwright']}`, 'playwright-core': `file:${packs['playwright-core']}` },
  }, null, 2));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--offline'], { cwd: project, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
}

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
writeFileSync(join(project, 'timeouts.ts'), `export type Timeout = number;
export const timeout: Timeout = 30000;
`);
writeFileSync(join(project, 'bun.config.ts'), `import { defineConfig, devices } from '@playwright/test';
import { type Timeout, timeout } from './timeouts';

const testTimeout: Timeout = timeout;
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  timeout: testTimeout,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`);

// The app server runs in this process, so the test runs must not block the event loop.
async function runSuite(command, args) {
  const started = performance.now();
  const child = spawn(command, args, { cwd: project });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const status = await new Promise(f => child.on('close', f));
  console.log(output.split('\n').slice(-6).join('\n'));
  console.log(`${command} exit=${status} in ${(performance.now() - started).toFixed(0)} ms`);
  return status ?? 1;
}

const nodeStatus = await runSuite('npx', ['playwright', 'test']);
// Bun runs TypeScript with its own loader, which Node's code paths must leave alone.
const hasBun = spawnSync('bun', ['--version']).status === 0;
const bunStatus = hasBun ? await runSuite('bunx', ['--bun', 'playwright', 'test', '--config=bun.config.ts']) : 0;
if (!hasBun)
  console.log('Bun is not installed: skipped the run on Bun.');
await server.close();
console.log(`installed: ${readdirSync(join(project, 'node_modules')).join(', ')}`);
process.exitCode = nodeStatus || bunStatus;
