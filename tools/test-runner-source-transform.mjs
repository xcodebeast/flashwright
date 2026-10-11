import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBun } from './bun-toolchain.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceHelper = process.argv.includes('--source-helper');
const arguments_ = process.argv.slice(2).filter(argument => argument !== '--source-helper');
assert.ok(arguments_.length <= 1, 'Pass an optional fresh output directory and --source-helper only for source controls');
assert.equal(await realpath(process.cwd()), await realpath(projectDirectory), 'Run from this checkout');
await mkdir(join(projectDirectory, '.cache'), { recursive: true });
const destination = arguments_.length ? resolve(arguments_[0]) : await mkdtemp(join(projectDirectory, '.cache/runner-source-transform-'));
if (arguments_.length) { await mkdir(dirname(destination), { recursive: true }); await mkdir(destination); }
const helperPath = join(projectDirectory, sourceHelper
  ? 'packages/flashwright-runner/runner-source-transform.cjs'
  : 'packages/flashwright-runner/dist/upstream/flashwright-source-transform.cjs');
const commonPath = join(projectDirectory, 'packages/flashwright-runner/dist/upstream/lib/common/index.js');
const pinnedCommonPath = join(projectDirectory, 'node_modules/flashwright-upstream-runner/lib/common/index.js');
const corePath = join(projectDirectory, 'packages/flashwright-core/dist/commonjs/index.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, helperPath, helperKind: sourceHelper ? 'source' : 'built', cases: [], failures: [],
  scope: 'JavaScript-only pinned Bun direct entry, startup options/configuration and original typed-source loading, plus built/pinned native .cjs and unknown-asset extension behavior. Known preload rejection occurs after runtime preload execution. No runner scheduling, browser, build, hidden-hook/spoofed-state completeness or performance admission.' };

async function saveJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

try {
  const bunPath = await realpath(requireBun());
  const identityPaths = [fileURLToPath(import.meta.url), helperPath, commonPath, pinnedCommonPath, corePath,
    join(projectDirectory, 'packages/flashwright-runner/dist/upstream/lib/transform/babelBundle.js'), bunPath];
  async function identities() {
    return Object.fromEntries(await Promise.all(identityPaths.map(async path => [path, hash(await readFile(path))])));
  }
  report.identitiesBefore = await identities();
  report.bunPath = bunPath;
  const fixtures = join(destination, 'fixtures');
  await mkdir(fixtures);
  const mainPath = join(fixtures, 'main.cjs');
  const pinnedMainPath = join(fixtures, 'pinned-main.cjs');
  const preloadPath = join(fixtures, 'preload.cjs');
  const emptyConfigPath = join(fixtures, 'empty.toml');
  const otherEmptyConfigPath = join(fixtures, 'other-empty.toml');
  const preloadConfigPath = join(fixtures, 'preload.toml');
  const localDirectory = join(fixtures, 'local');
  await mkdir(localDirectory);
  await writeFile(emptyConfigPath, 'preload = []\n', { flag: 'wx' });
  await writeFile(otherEmptyConfigPath, 'preload = []\n', { flag: 'wx' });
  const preloadConfig = `preload = [${JSON.stringify(preloadPath)}]\n`;
  await writeFile(preloadConfigPath, preloadConfig, { flag: 'wx' });
  await writeFile(join(localDirectory, 'bunfig.toml'), preloadConfig, { flag: 'wx' });
  await writeFile(preloadPath, "globalThis.sourceTransformPreloadMarker = 'preload-executed';\n", { flag: 'wx' });
  await writeFile(join(fixtures, 'dependency.cts'), 'export const value: number = 40;\n', { flag: 'wx' });
  await writeFile(join(fixtures, 'native-return.cjs'), "module.exports = 'native-return.cjs';\nreturn;\nthrow Error('Code after the native top-level return must not execute');\n", { flag: 'wx' });
  await writeFile(join(fixtures, 'unknown-asset.unknown'), "throw Error('Unknown assets must not execute as JavaScript');\n", { flag: 'wx' });
  await writeFile(pinnedMainPath, `const assert = require('node:assert/strict');
const { join } = require('node:path');
const { transform } = require(${JSON.stringify(pinnedCommonPath)});
const mode = process.argv[2];
const filename = join(__dirname, mode === 'native-cjs' ? 'native-return.cjs' : 'unknown-asset.unknown');
transform.requireOrImport(filename).then(value => {
  if (mode === 'native-cjs') assert.equal(value, 'native-return.cjs');
  else {
    assert.equal(value.__esModule, true);
    assert.equal(value.default, filename);
    assert.deepEqual(Object.keys(value).sort(), ['__esModule', 'default']);
  }
  console.log(JSON.stringify({ mode, bun: process.versions.bun, status: 'accepted',
    userConfigMarker: true, preloadMarker: null, nativeResult: value }));
}, error => { console.error(error.stack); process.exitCode = 1; });
`, { flag: 'wx' });
  await writeFile(join(fixtures, 'caller.ts'), `import type { IncomingMessage } from 'node:http';
import { value } from './dependency.cts';
type Answer = number;
export const answer: Answer = value + 2;
`, { flag: 'wx' });
  await writeFile(join(fixtures, 'forward.cjs'), `require(${JSON.stringify(helperPath)}).registerOwnedBootstrap(__filename);\n`, { flag: 'wx' });
  await writeFile(mainPath, `const assert = require('node:assert/strict');
const Module = require('node:module');
const { join } = require('node:path');
const core = require(${JSON.stringify(corePath)});
const helper = require(${JSON.stringify(helperPath)});
const mode = process.argv[2];
const state = { mode, bun: process.versions.bun, execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS || null, bunOptions: process.env.BUN_OPTIONS || null,
  preloadMarker: globalThis.sourceTransformPreloadMarker || null, userConfigMarker: false };

async function run() {
  if (mode === 'programmatic') {
    require('./forward.cjs');
  } else if (mode !== 'missing-bootstrap') {
    if (mode === 'ignored-fallback' || mode === 'unknown-fallback') {
      // This controlled baseline callback tests delegation, not default-loader provenance.
      Module._extensions['.custody'] = function(module, filename, ...arguments_) {
        state.fallback = { receiver: this === receiver, module: module === subject,
          filename, firstArgument: arguments_[0], secondArgument: arguments_[1] === argumentObject };
        return argumentObject;
      };
    }
    helper.registerOwnedBootstrap(__filename);
    if (mode === 'forwarding') require('./forward.cjs');
  }
  const common = require(${JSON.stringify(commonPath)});
  const resolver = Module._resolveFilename;
  const compiler = Module.prototype._compile;
  if (mode === 'native-cjs' || mode === 'unknown-asset') {
    const extension = mode === 'native-cjs' ? '.cjs' : '.unknown';
    const previousLoader = Module._extensions[extension];
    const filename = join(__dirname, mode === 'native-cjs' ? 'native-return.cjs' : 'unknown-asset.unknown');
    const value = await common.transform.requireOrImport(filename);
    if (mode === 'native-cjs') assert.equal(value, 'native-return.cjs');
    else {
      assert.equal(value.__esModule, true);
      assert.equal(value.default, filename);
      assert.deepEqual(Object.keys(value).sort(), ['__esModule', 'default']);
    }
    assert.equal(Module._extensions[extension], previousLoader);
    assert.equal(Module.prototype._compile, compiler);
    state.nativeResult = value;
    state.nativeExtensionLoaderUnchanged = true;
    state.userConfigMarker = true;
    return;
  }
  if (mode === 'later-loader') Module._extensions['.ts'] = function customLoader() {};
  if (mode === 'later-compiler') Module.prototype._compile = function customCompiler() {};
  const expectedLoaders = { ...Module._extensions };
  const expectedCompiler = Module.prototype._compile;
  const transformed = [];
  const transform = (source, filename) => {
    assert.match(source, /(?:answer|value): (?:Answer|number)/);
    transformed.push(filename);
    return common.transform.transformHook(source, filename);
  };
  let predicateCalls = 0;
  const shouldTransform = filename => {
    predicateCalls++;
    if (mode === 'unknown-fallback') throw Error('Unknown extensions must delegate before the transform predicate');
    return filename === join(__dirname, 'caller.ts') || filename === join(__dirname, 'dependency.cts');
  };
  let install;
  try {
    if (${!sourceHelper} && (mode === 'later-loader' || mode === 'later-compiler' || mode === 'missing-bootstrap')) {
      await common.transform.requireOrImport(join(__dirname, 'caller.ts'));
      throw Error('The actual owned transform unexpectedly accepted invalid custody');
    }
    install = helper.prepareOriginalSourceLoader(transform, shouldTransform,
      mode === 'ignored-fallback' || mode === 'unknown-fallback' ? ['.custody'] : ['.ts', '.cts']);
  } catch (error) {
    state.resolverUnchanged = Module._resolveFilename === resolver;
    state.loadersUnchanged = Object.keys(expectedLoaders).every(extension => Module._extensions[extension] === expectedLoaders[extension]);
    state.compilerUnchanged = Module.prototype._compile === expectedCompiler;
    assert.ok(state.resolverUnchanged && state.loadersUnchanged && state.compilerUnchanged);
    throw error;
  }
  install();
  if (mode === 'ignored-fallback' || mode === 'unknown-fallback') {
    const filename = mode === 'unknown-fallback' ? 'ignored.unknown' : 'ignored.custody';
    const result = Module._extensions['.custody'].call(receiver, subject, filename, 'first', argumentObject);
    assert.equal(result, argumentObject);
    assert.deepEqual(state.fallback, { receiver: true, module: true, filename, firstArgument: 'first', secondArgument: true });
    assert.equal(transformed.length, 0);
    assert.equal(predicateCalls, mode === 'unknown-fallback' ? 0 : 1);
    state.predicateCalls = predicateCalls;
  } else if (mode === 'module-compiler') {
    const subject = new Module(join(__dirname, 'caller.ts'));
    subject._compile = function thirdPartyCompiler() {};
    Module._extensions['.ts'](subject, subject.id);
  } else {
    const value = require('./caller.ts');
    assert.equal(value.answer, 42);
    assert.deepEqual(transformed, [join(__dirname, 'caller.ts'), join(__dirname, 'dependency.cts')]);
    state.answer = value.answer;
    state.originalTypedSourcesTransformedOnce = true;
  }
  assert.equal(Module.prototype._compile, compiler);
  state.userConfigMarker = true;
}
const receiver = {};
const subject = {};
const argumentObject = {};
run().then(() => {
  state.status = 'accepted';
  console.log(JSON.stringify(state));
}, error => {
  state.status = 'rejected';
  state.error = { name: error.name, message: error.message, stack: error.stack,
    typed: error instanceof core.UnsupportedFeatureError };
  console.error(error.stack);
  console.log(JSON.stringify(state));
  process.exitCode = 1;
});
`, { flag: 'wx' });

  const cases = [
    { name: 'clean-direct', mode: 'clean', accepted: true },
    { name: 'canonical-forwarding', mode: 'forwarding', accepted: true },
    { name: 'cwd-local-preload', cwd: localDirectory, preloaded: true },
    { name: 'explicit-preload-config', options: [`--config=${preloadConfigPath}`], preloaded: true },
    { name: 'explicit-empty-overrides-local', cwd: localDirectory, options: [`--config=${emptyConfigPath}`], accepted: true },
    { name: 'duplicate-identical-config', options: [`--config=${emptyConfigPath}`, `--config=${emptyConfigPath}`], accepted: true },
    { name: 'multiple-config-selections', options: [`--config=${emptyConfigPath}`, `--config=${otherEmptyConfigPath}`] },
    ...['--preload', '--require', '--import'].flatMap(option => [
      { name: `${option.slice(2)}-split`, options: [option, preloadPath], preloaded: true },
      { name: `${option.slice(2)}-equals`, options: [`${option}=${preloadPath}`], preloaded: true },
    ]),
    { name: 'short-require-split', options: ['-r', preloadPath], preloaded: true },
    { name: 'bun-options-preload-split', environment: { BUN_OPTIONS: `--preload ${JSON.stringify(preloadPath)}` } },
    { name: 'bun-options-preload-equals', environment: { BUN_OPTIONS: `--preload=${preloadPath}` }, preloaded: true },
    { name: 'node-options-require-split', environment: { NODE_OPTIONS: `--require ${JSON.stringify(preloadPath)}` } },
    { name: 'node-options-import-equals', environment: { NODE_OPTIONS: `--import=${JSON.stringify(preloadPath)}` } },
    { name: 'quoted-non-preload-node-option', environment: { NODE_OPTIONS: '--conditions="ordinary --preload -r value"' }, accepted: true },
    { name: 'quoted-non-preload-bun-option', environment: { BUN_OPTIONS: '--conditions="ordinary --preload -r value"' }, accepted: true },
    { name: 'malformed-quoted-node-options', environment: { NODE_OPTIONS: '--conditions="unterminated' } },
    ...['programmatic', 'missing-bootstrap', 'later-loader', 'later-compiler', 'module-compiler'].map(mode => ({ name: mode, mode })),
    { name: 'ignored-fallback-custody', mode: 'ignored-fallback', accepted: true },
    { name: 'unknown-extension-fallback-custody', mode: 'unknown-fallback', accepted: true },
    ...(!sourceHelper ? [
      { name: 'built-common-native-cjs-return', mode: 'native-cjs', accepted: true },
      { name: 'built-common-unknown-asset', mode: 'unknown-asset', accepted: true },
      { name: 'pinned-common-native-cjs-return', mode: 'native-cjs', pinned: true, accepted: true },
      { name: 'pinned-common-unknown-asset', mode: 'unknown-asset', pinned: true, accepted: true },
    ] : []),
  ];
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(FLASHWRIGHT_|PW_|PLAYWRIGHT_)/.test(name) && !['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'DEBUG', 'FORCE_COLOR'].includes(name)));
  for (const specification of cases) {
    const directory = join(destination, specification.name);
    await mkdir(directory);
    const command = [bunPath, ...(specification.options ?? []), specification.pinned ? pinnedMainPath : mainPath, specification.mode ?? 'clean'];
    const childEnvironment = { ...environment, ...(specification.environment ?? {}) };
    const child = spawnSync(command[0], command.slice(1), { cwd: specification.cwd ?? fixtures,
      env: childEnvironment, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    await writeFile(join(directory, 'stdout'), child.stdout ?? '', { flag: 'wx' });
    await writeFile(join(directory, 'stderr'), child.stderr ?? '', { flag: 'wx' });
    const outcome = { name: specification.name, command, cwd: specification.cwd ?? fixtures,
      environment: specification.environment ?? {}, expectedStatus: specification.accepted ? 'accepted' : 'rejected',
      exitCode: child.status, signal: child.signal, spawnError: child.error ? { name: child.error.name, message: child.error.message } : null };
    report.cases.push(outcome);
    try {
      assert.equal(outcome.spawnError, null);
      assert.equal(child.signal, null);
      assert.equal(child.status, specification.accepted ? 0 : 1);
      outcome.observed = JSON.parse(child.stdout.trim());
      assert.equal(outcome.observed.bun, '1.4.2');
      assert.equal(outcome.observed.status, outcome.expectedStatus);
      assert.equal(outcome.observed.userConfigMarker, !!specification.accepted);
      if (specification.preloaded) assert.equal(outcome.observed.preloadMarker, 'preload-executed');
      if (specification.accepted) {
        assert.equal(outcome.observed.preloadMarker, null);
        if (specification.mode === 'native-cjs' || specification.mode === 'unknown-asset') {
          if (specification.mode === 'native-cjs') assert.equal(outcome.observed.nativeResult, 'native-return.cjs');
          else assert.deepEqual(outcome.observed.nativeResult, { __esModule: true, default: join(fixtures, 'unknown-asset.unknown') });
          if (!specification.pinned) assert.equal(outcome.observed.nativeExtensionLoaderUnchanged, true);
        } else if (specification.mode === 'ignored-fallback' || specification.mode === 'unknown-fallback') {
          assert.equal(outcome.observed.predicateCalls, specification.mode === 'unknown-fallback' ? 0 : 1);
        } else assert.equal(outcome.observed.originalTypedSourcesTransformedOnce, true);
      } else {
        assert.equal(outcome.observed.error.name, 'UnsupportedFeatureError');
        assert.equal(outcome.observed.error.typed, true);
      }
      if (['missing-bootstrap', 'later-loader', 'later-compiler'].includes(specification.mode)) {
        assert.equal(outcome.observed.resolverUnchanged, true);
        assert.equal(outcome.observed.loadersUnchanged, true);
        assert.equal(outcome.observed.compilerUnchanged, true);
      }
      outcome.status = 'passed';
    } catch (error) {
      outcome.status = 'failed';
      outcome.verificationError = { name: error.name, message: error.message, stack: error.stack };
      report.failures.push(specification.name);
    } finally { await saveJson(join(directory, 'result.json'), outcome); }
  }
  report.identitiesAfter = await identities();
  assert.deepEqual(report.identitiesAfter, report.identitiesBefore, 'The tested helper/runtime inputs must remain unchanged');
  assert.deepEqual(report.failures, [], 'Every startup and loader custody case must pass');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await saveJson(join(destination, 'report.json'), report);
  console.log(JSON.stringify({ status: report.status, ...runtimeMetadata, helperKind: report.helperKind,
    cases: report.cases.length, report: join(destination, 'report.json'), ...(report.error ? { error: report.error.message } : {}) }));
}
