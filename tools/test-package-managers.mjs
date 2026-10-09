import { createHttpFixture } from './http-fixture.mjs';
import { requireBun, bunVersion } from './bun-toolchain.mjs';
import { javascriptRuntime, runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { startConsumerRegistry } from './consumer-registry.mjs';
import { writeConsumerFixtures } from './consumer-fixtures.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = await sourceManifest();
const destination = resolve(`compatibility/evidence/consumer-matrix-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const working = await mkdtemp(join(tmpdir(), 'flashwright-consumer-matrix-'));
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
const driver = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver');
const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
const watchdog = resolve('tools/watchdog.py');
const report = { status: 'running', ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  sources, browser, driverSha256: hash(await readFile(driver)), commands: [], cases: [],
  scope: 'Private packed artifacts acquired through a local registry using normal dependencies and npm aliases; Bun by default; npm, pnpm, Yarn node-modules and Yarn PnP under explicit Node compatibility runtimes. Browser execution uses the installed runtime without Cargo or a driver override. No public publication or performance claim.',
};

/** Every install, compiler and browser command has an independent external watchdog. */
async function run(label, command, { cwd = process.cwd(), env = process.env, timeout = 120, expectedExitCode = 0 } = {}) {
  const log = `${report.commands.length + 1}.log`;
  const output = createWriteStream(join(destination, log));
  console.log(`Consumer matrix: ${label}`);
  const child = spawn(python, [watchdog, '--timeout', String(timeout), '--report-directory', join(destination, 'resources'), '--', ...command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => output.write(bytes));
  const result = await new Promise(resolve => {
    child.on('error', error => resolve({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise(resolve => output.end(resolve));
  const bytes = await readFile(join(destination, log));
  report.commands.push({ label, command, cwd, ...result, expectedExitCode, log, sha256: hash(bytes) });
  assert.equal(result.code, expectedExitCode, `${label}: ${bytes.toString().slice(-12000)}`);
  return bytes.toString();
}

let registry;
let application;
let closeApplication;
try {
  const selected = process.argv.length > 2 ? process.argv.slice(2) : javascriptRuntime.name === 'bun' ? ['bun'] : ['npm', 'pnpm', 'yarn-node-modules', 'yarn-pnp'];
  assert.ok(selected.every(name => ['bun', 'npm', 'pnpm', 'yarn-node-modules', 'yarn-pnp'].includes(name)), 'Pass bun, npm, pnpm, yarn-node-modules or yarn-pnp');
  assert.ok(javascriptRuntime.name === 'node' || selected.every(name => name === 'bun'), 'Run non-Bun package managers under an explicit Node compatibility runtime');
  const managerRoot = resolve('.tools/consumer-package-managers');
  const pinnedTools = { pnpm: '10.23.0', '@yarnpkg/cli-dist': '4.18.1' };
  if (selected.some(name => name === 'pnpm' || name.startsWith('yarn-'))) {
    await mkdir(managerRoot, { recursive: true });
    await writeFile(join(managerRoot, 'package.json'), JSON.stringify({ private: true, dependencies: pinnedTools }, null, 2) + '\n');
    await run('install pinned consumer package managers', [requireBun(), 'install', '--ignore-scripts'], { cwd: managerRoot, timeout: 180 });
    await copyFile(join(managerRoot, 'bun.lock'), join(destination, 'manager-bun.lock'));
  }
  const managers = [
    { name: 'bun', packageManager: `bun@${bunVersion}`, command: [requireBun()], runArguments: ['run', '--bun'], runtime: { name: 'bun', version: bunVersion } },
    ...(selected.includes('npm') ? [{ name: 'npm', packageManager: `npm@${execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()}`, command: ['npm'] }] : []),
    { name: 'pnpm', packageManager: 'pnpm@10.23.0', command: [process.execPath, join(managerRoot, 'node_modules/pnpm/bin/pnpm.cjs')] },
    ...['node-modules', 'pnp'].map(linker => ({ name: `yarn-${linker}`, packageManager: 'yarn@4.18.1', command: [process.execPath, join(managerRoot, 'node_modules/@yarnpkg/cli-dist/bin/yarn.js')], linker })),
  ];
  const artifactsDirectory = join(destination, 'artifacts'); await mkdir(artifactsDirectory);
  const { archives } = await packConsumerPackages(artifactsDirectory, { runner: true });
  await run('pack checked platform executable', [process.execPath, 'tools/pack-driver-runtime.mjs', '--driver', driver, '--destination', join(working, 'runtime')]);
  const runtime = JSON.parse(await readFile(join(working, 'runtime/report.json'), 'utf8'));
  const runtimeArchive = join(artifactsDirectory, 'driver-runtime.tgz'); await copyFile(runtime.archive, runtimeArchive);
  archives.runtime = runtimeArchive;
  const referenceBytes = await readFile('compatibility/reference-manifest.json');
  const reference = JSON.parse(referenceBytes);
  report.foreignRuntimeMetadata = { referenceSha256: hash(referenceBytes), scope: 'Retained other-platform artifacts provide real registry metadata for optional dependency resolution. Their executables are not run or claimed current-platform conformance.', packages: [] };
  for (const artifact of reference.engineDevelopment.platformRuntimeArtifacts.filter(artifact => artifact.manifest.platform !== process.platform)) {
    const bytes = await readFile(artifact.archive);
    assert.equal(hash(bytes), artifact.archiveSha256, 'Foreign platform fixture checksum changed');
    const name = `driver-${artifact.manifest.platform}-${artifact.manifest.architecture}`;
    const path = join(artifactsDirectory, `${name}.tgz`); await writeFile(path, bytes);
    archives[name] = path;
    report.foreignRuntimeMetadata.packages.push(artifact.manifest.packageName);
  }
  report.artifacts = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, archive]) => [name, { path: archive, sha256: hash(await readFile(archive)) }])));
  report.runtimeManifest = runtime.manifest;
  registry = await startConsumerRegistry(Object.values(archives));
  ({ server: application, close: closeApplication } = createHttpFixture((_request, response) => response.end('<title>Consumer matrix</title><form onsubmit="event.preventDefault();document.querySelector(\'output\').textContent=\'Saved \'+document.querySelector(\'input\').value"><label>Name<input></label><button>Save</button></form><output role="status">Ready</output>')));
  application.listen(0, '127.0.0.1'); await once(application, 'listening');
  const environment = { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PLAYWRIGHT_SKIP_BROWSER_GC: '1', FLASHWRIGHT_BROWSER_PATH: browser.executablePath,
    FLASHWRIGHT_TEST_BASE_URL: `http://127.0.0.1:${application.address().port}`, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' };
  delete environment.FLASHWRIGHT_DRIVER_PATH;
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  for (const manager of managers.filter(manager => !selected.length || selected.includes(manager.name))) {
    for (const mode of ['library-only', 'direct', 'aliases', 'workspace-aliases']) {
      const label = `${manager.name}-${mode}`;
      const directory = join(working, label); await mkdir(directory);
      const evidence = join(destination, label); await mkdir(evidence);
      const workspace = mode === 'workspace-aliases';
      const consumer = workspace ? join(directory, 'packages/example') : directory;
      await mkdir(consumer, { recursive: true });
      const aliases = mode.includes('aliases');
      const libraryOnly = mode === 'library-only';
      const dependencies = { [aliases ? 'playwright' : 'flashwright']: aliases ? 'npm:flashwright@0.0.0' : '0.0.0',
        ...(libraryOnly ? {} : { '@flashwright/test': '0.0.0', ...(aliases ? { '@playwright/test': 'npm:@flashwright/test@0.0.0' } : {}), typescript: '5.9.3', '@types/node': '24.10.1' }) };
      const scripts = { identity: `${manager.name === 'bun' ? 'bun' : 'node'} identity.mjs`, types: 'tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext declarations.mts declarations.cts',
        bundler: 'tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler declarations.mts', test: 'flashwright test --config playwright.config.mjs' };
      const manifest = { name: `consumer-${label}`, private: true, type: 'module', packageManager: manager.packageManager, dependencies, scripts };
      await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
      if (workspace) await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `workspace-${label}`, private: true, packageManager: manager.packageManager, workspaces: ['packages/*'] }, null, 2) + '\n');
      await writeFile(join(directory, '.npmrc'), `registry=${registry.url}\nignore-scripts=true\naudit=false\nfund=false\n`);
      if (manager.name === 'pnpm') await writeFile(join(directory, 'pnpm-workspace.yaml'), workspace ? "packages:\n  - 'packages/*'\n" : 'packages: []\n');
      if (manager.linker) {
        await writeFile(join(directory, 'yarn.lock'), '');
        // Fresh private fixture versions have no public registry age; other packages retain Yarn's gates.
        await writeFile(join(directory, '.yarnrc.yml'), `nodeLinker: ${manager.linker}\nnpmRegistryServer: ${JSON.stringify(registry.url)}\nunsafeHttpWhitelist:\n  - 127.0.0.1\nnpmPreapprovedPackages: ${JSON.stringify(registry.packageDescriptors)}\nenableScripts: false\nenableTelemetry: false\nenableGlobalCache: false\nglobalFolder: ${JSON.stringify(join(directory, '.yarn/global'))}\npnpEnableEsmLoader: true\n`);
      }
      await writeConsumerFixtures(consumer, { aliases, libraryOnly });
      const consumerEnvironment = { ...environment, PATH: `${dirname(manager.name === 'bun' ? requireBun() : process.execPath)}:/usr/bin:/bin`, FLASHWRIGHT_CONSUMER_ROOT: await realpath(directory) };
      const options = { cwd: directory, env: consumerEnvironment };
      const version = (await run(`${label} manager identity`, [...manager.command, '--version'], options)).trim();
      assert.equal(version, manager.packageManager.split('@').at(-1));
      await run(`${label} install`, [...manager.command, 'install', ...(manager.linker ? ['--mode=skip-build'] : ['--ignore-scripts'])], { ...options, timeout: 180 });
      for (const filename of ['package.json', 'bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs']) {
        await copyFile(join(directory, filename), join(evidence, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await copyFile(join(consumer, 'package.json'), join(evidence, 'consumer-package.json'));
      const unsupportedRunner = !libraryOnly && manager.linker === 'pnp';
      for (const script of ['identity', ...(libraryOnly ? [] : ['types', 'bundler']), ...(!libraryOnly && !unsupportedRunner ? ['test'] : [])]) await run(`${label} ${script}`, [...manager.command, ...(manager.runArguments ?? ['run']), script], { cwd: consumer, env: consumerEnvironment });
      if (unsupportedRunner) {
        const output = await run(`${label} runner preflight`, [...manager.command, ...(manager.runArguments ?? ['run']), 'test'], { cwd: consumer, env: consumerEnvironment, expectedExitCode: 1 });
        assert.match(output, /UnsupportedFeatureError: flashwright test: Yarn Plug'n'Play/);
        assert.match(output, /nodeLinker: node-modules/);
        assert.equal(await readFile(join(consumer, 'report.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'Unsupported runner entered test execution');
      } else if (!libraryOnly) {
        const result = JSON.parse(await readFile(join(consumer, 'report.json'), 'utf8'));
        assert.equal(result.stats.expected, 3); assert.equal(result.stats.unexpected, 0);
        await copyFile(join(consumer, 'report.json'), join(evidence, 'runner-report.json'));
      }
      report.cases.push({ manager: manager.name, version, runtime: manager.runtime ?? javascriptRuntime, mode, status: 'passed', runner: libraryOnly ? 'not-installed' : unsupportedRunner ? 'unsupported-preflight-verified' : 'three-tests-passed', consumer, evidence });
    }
  }
  for (const name of report.foreignRuntimeMetadata.packages) assert.ok(!registry.requests.some(request => request.path === `artifacts/${name}`), `Consumer fetched a driver for another platform: ${name}`);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; }
finally {
  if (application) await closeApplication();
  if (registry) { report.registryRequests = registry.requests; await registry.close(); }
}
report.sourceChangedDuringVerification = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
report.driverChangedDuringVerification = report.driverSha256 !== hash(await readFile(driver));
report.browserChangedDuringVerification = browser.sha256 !== hash(await readFile(browser.executablePath));
if (report.sourceChangedDuringVerification || report.driverChangedDuringVerification || report.browserChangedDuringVerification) report.status = 'failed';
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Consumer matrix ${report.status}: ${destination}/report.json`);
if (report.error) console.error(report.error);
process.exitCode = report.status === 'passed' ? 0 : 1;
