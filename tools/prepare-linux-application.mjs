import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applicationCorpusDirectory, loadApplicationCorpus, materializeApplicationTests } from '../benchmarks/application-corpus.mjs';
import { applicationConfiguration } from '../benchmarks/application-suite-contract.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { dependencyManifest, hash } from './competitor-inputs.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.versions.bun, '1.4.2');
assert([5, 6].includes(process.argv.length), 'Usage: bun tools/prepare-linux-application.mjs NEW_WORKBENCH_DIRECTORY todomvc|svgomg playwright|flashwright [1|4]');
const [directoryName, application, engine, workerArgument = '1'] = process.argv.slice(2);
assert(['1', '4'].includes(workerArgument), 'Application policy requires one or four workers');
const workers = Number(workerArgument);
assert(['todomvc', 'svgomg'].includes(application));
assert(['playwright', 'flashwright'].includes(engine));
const workspace = resolve('.');
const directory = resolve(directoryName);
const within = relative(join(workspace, 'workbench'), directory);
assert(within && !isAbsolute(within) && !within.split('/').includes('..'), 'Raw preparation must stay in workbench');
for (const key of ['FLASHWRIGHT_BROWSER_PATH', 'FLASHWRIGHT_DRIVER_PATH', 'FLASHWRIGHT_CGROUP_COLLECTOR'])
  assert(isAbsolute(process.env[key] ?? ''), `Set absolute ${key}`);
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH;
const collector = process.env.FLASHWRIGHT_CGROUP_COLLECTOR;
await mkdir(directory);
const project = join(directory, 'project');
await mkdir(project);
const corpus = await loadApplicationCorpus(applicationCorpusDirectory(application));
const adapter = join(project, 'adapter.mjs');
const guard = engine === 'flashwright' ? `import { forbidUpstreamBrowserBackend } from ${JSON.stringify(pathToFileURL(resolve('benchmarks/native-backend-guard.mjs')).href)}; forbidUpstreamBrowserBackend();\n` : '';
await writeFile(adapter, `${guard}export {test,expect,defineConfig} from ${JSON.stringify(import.meta.resolve(engine === 'flashwright' ? '@flashwright/test' : '@playwright/test'))};\n`, { flag: 'wx' });
const generatedSources = await materializeApplicationTests(corpus, project, adapter);
const configuration = applicationConfiguration(project, browser, workers);
const configurationPath = join(project, 'runner.config.mjs');
await writeFile(configurationPath, `import {defineConfig} from './adapter.mjs';export default defineConfig(${JSON.stringify(configuration)});\n`, { flag: 'wx' });
const files = ['adapter.mjs', 'runner.config.mjs', ...generatedSources.map(source => source.path)];
const generatedHashes = Object.fromEntries(await Promise.all(files.map(async path => [path, hash(await readFile(join(project, path)))])));
const require = createRequire(import.meta.url);
const cli = engine === 'flashwright' ? resolve('packages/flashwright-test/cli.cjs') : join(dirname(require.resolve('playwright/package.json')), 'cli.js');
const prepared = { schemaVersion: 1, application, engine, workers, workspaceDirectory: workspace, directory, project,
  browser, driverPath, collector, configuration, corpusManifestSha256: corpus.manifestSha256, generatedSources, generatedHashes,
  runnerCommand: [process.execPath, cli, 'test', '--config', configurationPath],
  ownerCommand: [process.execPath, resolve('benchmarks/linux-application-owner.mjs'), directory],
  scope: 'Complete application owner with unchanged callback bodies; source-to-runner-result joining, not callback execution attestation. No final performance admission.' };
await writeFile(join(directory, 'prepared.json'), JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' });
const receipt = async path => { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: hash(bytes) }; };
const sources = await dependencyManifest(workspace, ['packages', 'crates', 'tools', 'benchmarks', 'Cargo.toml', 'Cargo.lock', 'package.json', 'bun.lock',
  'compatibility/migration-projects/offline-todomvc', 'compatibility/migration-projects/offline-svgomg']);
// Derived Python caches are not source inputs. Capture callers keep their
// interpreter cache in a fresh workbench prefix and disable cache writes.
for (const path of Object.keys(sources))
  if (path.split('/').includes('__pycache__') || path.endsWith('.pyc')) delete sources[path];
const dependencies = await dependencyManifest(workspace, ['node_modules']);
for (const [name, manifest] of [['source-manifest.json', sources], ['dependency-manifest.json', dependencies]])
  await writeFile(join(directory, name), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
const browserAssets = await dependencyManifest(dirname(browser.executablePath), ['.']);
const request = { schemaVersion: 1,
  source: { root: workspace, manifest: await receipt(join(directory, 'source-manifest.json')) },
  dependencies: { root: workspace, manifest: await receipt(join(directory, 'dependency-manifest.json')) },
  controls: await Promise.all([join(directory, 'prepared.json'), collector, ...files.map(path => join(project, path))].map(receipt)),
  runtimeAssets: await Promise.all(Object.keys(browserAssets).map(path => receipt(resolve(dirname(browser.executablePath), path)))),
  executables: { runtime: await receipt(process.execPath), browser: await receipt(browser.executablePath),
    driver: await receipt(driverPath), launcher: await receipt('/usr/bin/bwrap') } };
await writeFile(join(directory, 'capture-inputs.json'), JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, application, engine, workers, tests: corpus.manifest.expectedTests,
  sourceFiles: Object.keys(sources).length, dependencyFiles: Object.keys(dependencies).length, browserAssets: request.runtimeAssets.length }));
