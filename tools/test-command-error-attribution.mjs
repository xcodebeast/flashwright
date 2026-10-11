import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types as runtimeTypes } from 'node:util';
import vm from 'node:vm';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreDirectory = join(repositoryDirectory, 'packages/flashwright-core/dist/commonjs');
const runnerDirectory = join(repositoryDirectory, 'packages/flashwright-runner/dist/commonjs');
const upstreamDirectory = join(repositoryDirectory, 'packages/flashwright-runner/dist/upstream');
const coreRequire = createRequire(join(coreDirectory, 'client.js'));
const upstreamRequire = createRequire(join(upstreamDirectory, 'package.json'));
const checks = [];

function initializeOwnedHostTransform() {
  if (process.versions.bun)
    upstreamRequire('./flashwright-source-transform.cjs').registerOwnedBootstrap(fileURLToPath(import.meta.url));
}

initializeOwnedHostTransform();
await mkdir(join(repositoryDirectory, '.cache'), { recursive: true });
const fixtureDirectory = await mkdtemp(join(repositoryDirectory, '.cache/command-error-attribution-'));
const previousCacheDirectory = process.env.PWTEST_CACHE_DIR;
process.env.PWTEST_CACHE_DIR = join(fixtureDirectory, 'transform-cache');
const previousFormatter = Error.prepareStackTrace;
let applicationFormatter = previousFormatter;
let removeMapper = () => {};

try {
  const { transform, cc: compilationCache } = upstreamRequire('./lib/common/index.js');
  const { serializeError } = upstreamRequire('./lib/util.js');
  const { iso } = upstreamRequire('playwright-core/lib/coreBundle');
  const { sourceMapSupport } = upstreamRequire('playwright-core/lib/utilsBundle');
  const core = coreRequire('./index.js');
  const errors = coreRequire('./errors.js');
  const callers = coreRequire('./call-sites.js');
  const { engineHandshake, requiredCapabilities } = coreRequire('./engine-contract.js');
  const { residentRuntimeSha256 } = coreRequire('./runtime-version.cjs');
  const { buildFailureContext } = coreRequire(join(runnerDirectory, 'failure-context-format.js'));
  const mappedPositions = [];
  removeMapper = callers.installSourcePositionMapper(position => {
    const mapped = sourceMapSupport.mapSourcePosition(position);
    if (position.source.startsWith(fixtureDirectory)) mappedPositions.push({ original: position, mapped });
    return mapped;
  });

  /** Read current build output into memory so a peer can replace spawn without a production test seam. */
  async function loadBuiltModule(filename, overrides = {}, runtimeDirectory = dirname(filename)) {
    const module = { exports: {} };
    const originalRequire = createRequire(filename);
    const scopedRequire = Object.assign(function requireDependency(specifier) {
      return Object.hasOwn(overrides, specifier) ? overrides[specifier] : originalRequire(specifier);
    }, originalRequire);
    vm.runInNewContext(await readFile(filename, 'utf8'), {
      module, exports: module.exports, require: scopedRequire, __filename: filename, __dirname: runtimeDirectory,
      process, Buffer, Error, Promise, Map, Set, WeakMap, WeakSet, AbortController, Bun: globalThis.Bun,
      setTimeout, clearTimeout, setImmediate, queueMicrotask,
    }, { filename });
    return module.exports;
  }

  /** Feed actual control frames through the current EngineClient without launching another process. */
  function createProtocolPeer() {
    const child = new EventEmitter();
    const commands = [];
    const cancellations = [];
    const pending = new Map();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const liveness = new PassThrough();
    let incoming = Buffer.alloc(0);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      pending.clear();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    };
    const reply = message => {
      const body = Buffer.from(JSON.stringify(message));
      const frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      queueMicrotask(() => stdout.write(frame));
    };
    const errorRecord = (code, parameters = {}) => ({
      code, method: 'locator.click', message: parameters.message ?? 'locator resolved to no elements',
      inputDelivery: 'notDispatched', referenceVersion: '1.60.0', browser: 'chromium',
      diagnostics: { originalObservation: true },
    });
    const stdin = new Writable({
      write(bytes, encoding, complete) {
        incoming = Buffer.concat([incoming, bytes]);
        while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
          const length = incoming.readUInt32LE(0);
          const message = JSON.parse(incoming.subarray(4, length + 4));
          incoming = incoming.subarray(length + 4);
          if (message.kind === 'handshake') {
            assert.deepEqual(message.handshake, engineHandshake);
            reply({ kind: 'handshake', handshake: message.handshake, capabilities: requiredCapabilities, residentRuntimeSha256 });
          } else if (message.kind === 'command') {
            commands.push(message);
            if (message.parameters.mode === 'cancel' || message.parameters.mode === 'hold') pending.set(message.requestId, message);
            else reply({ kind: 'error', requestId: message.requestId, error: errorRecord('TargetClosedError', message.parameters) });
          } else if (message.kind === 'cancel') {
            assert.ok(pending.has(message.requestId), 'cancel an accepted original command');
            pending.delete(message.requestId);
            cancellations.push(message.requestId);
            reply({ kind: 'error', requestId: message.requestId, error: errorRecord('CancelledError') });
          } else assert.fail(`Unexpected host peer message: ${message.kind}`);
        }
        complete();
      },
      final(complete) {
        assert.equal(pending.size, 0, 'all accepted commands reach terminal state before release');
        complete();
        queueMicrotask(close);
      },
    });
    Object.assign(child, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, liveness] });
    child.kill = () => assert.fail('the host peer must close cleanly without a process kill');
    return { child, commands, cancellations, disconnect: close };
  }

  async function withClient(check) {
    const peer = createProtocolPeer();
    const { EngineClient } = await loadBuiltModule(join(coreDirectory, 'client.js'), {
      'node:child_process': { spawn(executable, arguments_, options) {
        assert.equal(executable, 'host-protocol-peer');
        assert.deepEqual(Array.from(arguments_), []);
        assert.deepEqual(Array.from(options.stdio), ['pipe', 'pipe', 'pipe', 'pipe']);
        return peer.child;
      } },
    });
    const client = new EngineClient('host-protocol-peer');
    client.retain();
    try { await check(client, peer); }
    catch (error) { peer.disconnect(); throw error; }
    finally { await client.release(); }
  }

  async function captureError(operation) {
    const formatter = Error.prepareStackTrace;
    Error.prepareStackTrace = () => { throw new Error('application stack formatter must not run during command attribution'); };
    try { return await operation().then(() => assert.fail('operation must fail'), error => error); }
    finally { Error.prepareStackTrace = formatter; }
  }

  function assertCallExpression(location, fixture) {
    assert.equal(location?.file, fixture.filename, 'select the original typed helper');
    assert.equal(location.line, fixture.line, 'select its exact original statement line');
    const statement = fixture.source.split('\n')[fixture.line - 1];
    const callToken = fixture.expression.split('.').at(-1);
    const start = statement.indexOf(callToken) + 1;
    assert.ok(start > 0);
    assert.ok(location.column >= start && location.column <= start + callToken.length, 'column identifies the actual method token or its opening parenthesis');
  }

  async function assertSelectedCaller(error, fixture, priorErrors = [], sourceExpected = true) {
    const serialized = serializeError(error);
    const location = iso.parseErrorStack(serialized.stack, '/').location;
    assertCallExpression(location, fixture);
    const markdown = await buildFailureContext({
      titlePath: ['command attribution', 'host peer failure'],
      location: { file: fixture.filename, line: fixture.line - 1, column: 1 },
      errors: [...priorErrors, serialized],
    });
    if (sourceExpected) {
      const width = String(fixture.source.split('\n').length).length;
      assert.ok(markdown.includes(`> ${String(fixture.line).padEnd(width, ' ')} | ${fixture.source.split('\n')[fixture.line - 1]}`));
      assert.ok(markdown.includes(`${' '.repeat(width + 2)} | ${' '.repeat(Math.max(0, location.column - 2))} ^ `), 'caret follows the exact serialized caller column');
    } else assert.match(markdown, /Test source omitted: stack exceeds/);
    assert.doesNotMatch(markdown, /class FlashwrightError|function fromRecord/);
    assert.equal(Error.prepareStackTrace, applicationFormatter);
    return location;
  }

  async function writeFixture(name, source, line, expression) {
    const filename = join(fixtureDirectory, name);
    await writeFile(filename, source);
    return { filename, source, line, expression };
  }

  async function assertOriginalMap(fixture) {
    const entry = compilationCache.serializeCompilationCache().memoryCache.find(([filename]) => filename === fixture.filename)?.[1];
    assert.ok(entry, 'owned transform retained a compilation entry');
    const map = JSON.parse(await readFile(entry.sourceMapPath, 'utf8'));
    assert.equal(map.sourcesContent[0], fixture.source, 'source map contains original typed input');
  }

  function createPage(client) {
    const context = new core.BrowserContext(client, 'helper-context', {}, null, undefined);
    return new core.Page(client, 'helper-page', context, false, {
      identifier: 'helper-page', mainFrame: 'main-frame', navigationSequence: 0,
      frames: [{ identifier: 'main-frame', parent: null, name: '', url: 'about:blank', navigationSequence: 0, loader: 'initial-loader' }],
    });
  }

  async function waitForAcceptedCommands(peer, count) {
    for (let iteration = 0; iteration < 20 && peer.commands.length < count; iteration++)
      await new Promise(resolve => setImmediate(resolve));
    assert.equal(peer.commands.length, count);
  }

  /** Inject only structured frames into the built capture module to check package ownership and bounds. */
  async function verifyCallerOwnership() {
    const sourceDirectory = resolve(coreDirectory, '../../src');
    for (const runtimeDirectory of [sourceDirectory, coreDirectory]) {
      for (const basename of ['application-helper.ts', 'call-sites.ts', 'call-sites.js']) {
        const unrelated = join(fixtureDirectory, 'packages/src', basename);
        const frames = [
          { scriptName: pathToFileURL(join(sourceDirectory, 'call-sites.ts')).href, lineNumber: 1, columnNumber: 1, functionName: 'callerLocations' },
          { scriptName: join(sourceDirectory, 'index.ts'), lineNumber: 10, columnNumber: 4, functionName: 'frameworkCall' },
          { scriptName: pathToFileURL(unrelated).href, lineNumber: 7, columnNumber: 3, functionName: 'applicationHelper' },
        ];
        const capture = await loadBuiltModule(join(coreDirectory, 'call-sites.js'), {
          'node:util': { getCallSites: () => frames },
        }, runtimeDirectory);
        assert.equal(capture.callerLocations().length, 2, 'exclude only the owned caller-capture module');
        const stack = capture.callerStack();
        assert.equal(iso.parseErrorStack(stack, '/').location.file, unrelated);
        assert.match(stack, /Captured Flashwright frames:/);
      }
    }
    const capture = await loadBuiltModule(join(coreDirectory, 'call-sites.js'), {
      'node:util': { getCallSites: () => Array.from({ length: 64 }, (_, index) => ({
        scriptName: join(fixtureDirectory, 'x'.repeat(800), `${index}.ts`), lineNumber: 1, columnNumber: 1, functionName: 'helper',
      })) },
    });
    const locations = capture.callerLocations();
    assert.ok(locations.length > 0);
    assert.ok(locations.length <= 32);
    assert.ok(Buffer.byteLength(JSON.stringify(locations)) <= 16384);
    checks.push('source/dist ownership preserves unrelated matching basenames and file URLs; caller list remains bounded');
  }

  /** Controlled synthetic loaders prove delegation semantics without certifying native startup custody. */
  async function verifyIgnoredLoaderDelegation() {
    const observations = [];
    const receiver = {};
    const firstArgument = Symbol('first loader argument');
    const secondArgument = Symbol('second loader argument');
    function fixtureLoader(...arguments_) { observations.push({ receiver: this, arguments_ }); return 'original loader result'; }
    function fixtureCompiler() { assert.fail('ignored input must not be compiled by the owned transform'); }
    const syntheticModule = { _extensions: { '.js': fixtureLoader }, prototype: { _compile: fixtureCompiler } };
    const sourceTransform = await loadBuiltModule(join(upstreamDirectory, 'flashwright-source-transform.cjs'), {
      'node:module': syntheticModule,
      '@flashwright/core': errors,
    });
    if (!process.versions.bun) return;
    sourceTransform.registerOwnedBootstrap(fileURLToPath(import.meta.url));
    sourceTransform.prepareOriginalSourceLoader(() => assert.fail('ignored input must not enter Babel'), () => false, ['.jsx'])();
    const module = { _compile: fixtureCompiler };
    assert.equal(syntheticModule._extensions['.jsx'].call(receiver, module, 'ignored.jsx', firstArgument, secondArgument), 'original loader result');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].receiver, receiver);
    assert.deepEqual(observations[0].arguments_, [module, 'ignored.jsx', firstArgument, secondArgument]);
    checks.push('ignored-loader fallback preserves original receiver, arguments, and result');
  }

  await writeFile(join(fixtureDirectory, 'package.json'), '{"type":"commonjs"}\n');
  const commandSource = `type CommandClient = { request(method: string, parameters: unknown, timeout: number, binary: boolean, input: undefined, readiness?: Promise<unknown>): Promise<unknown> };
type Options = { mode?: string; message?: string; timeout?: number; readiness?: Promise<unknown> };
const typedValue: Record<string, number> = { retained: 1 };
void typedValue;
module.exports = async function applicationCommandHelper(client: CommandClient, options: Options = {}) {
  return await client.request('locator.run', options, options.timeout ?? 0, false, undefined, options.readiness);
};
`;
  const firstFixture = await writeFixture('command-helper.cts', commandSource, 6, 'client.request');
  const secondFixture = await writeFixture('second-command-helper.cts', commandSource.replace('module.exports = async function applicationCommandHelper', 'void typedValue;\nvoid typedValue;\nmodule.exports = async function secondCommandHelper'), 8, 'client.request');
  const firstHelper = await transform.requireOrImport(firstFixture.filename);
  const secondHelper = await transform.requireOrImport(secondFixture.filename);
  applicationFormatter = Error.prepareStackTrace;
  const factoryRecord = { code: 'TargetClosedError', method: 'locator.click', message: 'factory formatter control' };
  const factoryCaller = `Error\n    at helper (${firstFixture.filename}:6:23)`;
  const factoryError = await captureError(async () => {
    const formatterDescriptor = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    const error = errors.fromRecord(factoryRecord, factoryCaller);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'), formatterDescriptor, 'factory must not change the application formatter descriptor');
    throw error;
  });
  assert.ok(factoryError instanceof errors.TargetClosedError, 'actual factory must retain the typed failure under a throwing application formatter');
  assert.ok(factoryError instanceof Error);
  assert.ok(runtimeTypes.isNativeError(factoryError), 'attributed error retains the native Error brand');
  if (typeof Error.isError === 'function') assert.ok(Error.isError(factoryError));
  assert.equal(Object.getPrototypeOf(factoryError), errors.TargetClosedError.prototype);
  assert.equal(factoryError.name, 'TargetClosedError');
  assert.equal(factoryError.message, 'locator.click: factory formatter control');
  assert.equal(factoryError.details, factoryRecord);
  assert.match(factoryError.stack, /factory formatter control/);
  assert.ok(factoryError.stack.length <= 32768);
  const stackDescriptor = Object.getOwnPropertyDescriptor(factoryError, 'stack');
  assert.equal(stackDescriptor.value, factoryError.stack);
  assert.equal(stackDescriptor.enumerable, false);
  assert.equal(stackDescriptor.writable, true);
  assert.equal(stackDescriptor.configurable, true);
  checks.push('actual built factory retains native Error brand, public prototype/fields and bounded own stack without changing or invoking application formatter');
  await assertOriginalMap(firstFixture);
  await assertOriginalMap(secondFixture);
  assert.equal(await transform.requireOrImport(firstFixture.filename), firstHelper);

  const existingFixture = await writeFixture('existing-caller.cts', `type Context = { newPage(): Promise<unknown> };
const values: Record<string, string> = {
  first: 'first',
  second: 'second',
};
void values;
module.exports = async function userCallSite(context: Context) {
  return await context.newPage();
};
`, 8, 'context.newPage');
  const existingHelper = await transform.requireOrImport(existingFixture.filename);
  await withClient(async client => {
    const context = new core.BrowserContext(client, 'host-context', {}, null, undefined);
    await assertSelectedCaller(await captureError(() => existingHelper(context)), existingFixture);
  });
  await assertOriginalMap(existingFixture);
  const exportedFixture = await writeFixture('exported-helper.ts', `import type { Page } from 'fixture-types';
type ProbeLabel = string;

export async function failFromHelper(page: Page, timeout: number): Promise<void> {
  const label: ProbeLabel = 'missing helper button';
  await page.getByRole('button', { name: label }).click({ timeout });
}
`, 6, 'click');
  const importer = await writeFixture('importer.cts', "import { failFromHelper } from './exported-helper';\nmodule.exports = failFromHelper;\n", 1, 'failFromHelper');
  const exportedHelper = await transform.requireOrImport(importer.filename);
  await withClient(async client => {
    const error = await captureError(() => exportedHelper(createPage(client), 1000));
    await assertSelectedCaller(error, exportedFixture);
  });
  await assertOriginalMap(exportedFixture);
  checks.push('actual owned require maps conflicting typed fixtures to lines8/6 and imported exported helper6 with call-expression columns');

  const pluginPath = join(fixtureDirectory, 'configured-plugin.cjs');
  await writeFile(pluginPath, `module.exports = function({ types }) {
  return { visitor: {
    StringLiteral(path) { if (path.node.value === 'configured-input') path.node.value = 'configured-output'; },
    ExpressionStatement(path) {
      if (path.node.expression.type !== 'AwaitExpression' || path.node.__injected) return;
      path.node.__injected = true;
      path.insertBefore([types.expressionStatement(types.stringLiteral('generated first')), types.expressionStatement(types.stringLiteral('generated second'))]);
    },
  } };
};\n`);
  transform.setTransformConfig({ babelPlugins: [[pluginPath, {}]], external: [pluginPath] });
  const pluginValue = await writeFixture('configured-value.cts', "const label: string = 'configured-input';\nmodule.exports = label;\n", 2, 'module.exports');
  assert.equal(await transform.requireOrImport(pluginValue.filename), 'configured-output');
  const pluginFixture = await writeFixture('configured-helper.ts', exportedFixture.source, 6, 'click');
  const pluginHelper = (await transform.requireOrImport(pluginFixture.filename)).failFromHelper;
  await withClient(async client => {
    await assertSelectedCaller(await captureError(() => pluginHelper(createPage(client), 1000)), pluginFixture);
  });
  await assertOriginalMap(pluginFixture);
  const tsconfigPath = join(fixtureDirectory, 'tsconfig.json');
  await writeFile(tsconfigPath, JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@fixture/*': ['./*'] } } }));
  transform.setSingleTSConfig(tsconfigPath);
  const aliasFixture = await writeFixture('paths-importer.ts', "import { failFromHelper } from '@fixture/exported-helper';\nexport { failFromHelper };\n", 1, 'failFromHelper');
  assert.equal((await transform.requireOrImport(aliasFixture.filename)).failFromHelper, exportedHelper);
  const generatedFixture = await writeFixture('vm-command-helper.cts', commandSource, 6, 'client.request');
  const generatedModule = { exports: {} };
  vm.runInNewContext(transform.transformHook(generatedFixture.source, generatedFixture.filename).code, {
    module: generatedModule, exports: generatedModule.exports, require: coreRequire,
  }, { filename: generatedFixture.filename });
  await withClient(async client => {
    await assertSelectedCaller(await captureError(() => generatedModule.exports(client, {})), generatedFixture);
  });
  await assertOriginalMap(generatedFixture);
  transform.setTransformConfig({ babelPlugins: [], external: [] });
  checks.push('configured Babel transforms and inserted statements, tsconfig aliases, and mixed VM/require modules retain one original-source mapping path');

  await verifyCallerOwnership();
  await verifyIgnoredLoaderDelegation();
  await withClient(async (client, peer) => {
    const nativeReply = await captureError(() => firstHelper(client, {}));
    assert.ok(nativeReply instanceof errors.TargetClosedError);
    assert.equal(nativeReply.message, 'locator.click: locator resolved to no elements');
    assert.equal(nativeReply.details.diagnostics.originalObservation, true);
    assert.equal(nativeReply.details.inputDelivery, 'notDispatched');
    assert.match(nativeReply.stack, /Called from:/);
    assert.match(nativeReply.stack, /Captured Flashwright frames:/);
    await assertSelectedCaller(nativeReply, firstFixture);
    assert.ok(mappedPositions.some(position => position.original.source === firstFixture.filename && position.original.line !== position.mapped.line), 'both runtimes invoke the supplied mapper for generated helper positions');
    await assertSelectedCaller(nativeReply, firstFixture, [{ message: 'Test timeout of 30000ms exceeded.' }]);
    checks.push('framed typed reply preserves diagnostics and caller selection, including a stackless primary test timeout');

    const expired = await captureError(() => firstHelper(client, { mode: 'cancel', timeout: 25 }));
    assert.ok(expired instanceof errors.TimeoutError);
    assert.equal(expired.details.method, 'locator.click');
    assert.equal(expired.details.inputDelivery, 'notDispatched');
    assert.equal(peer.cancellations.length, 1);
    await assertSelectedCaller(expired, firstFixture);
    const commandCount = peer.commands.length;
    const readinessExpired = await captureError(() => firstHelper(client, { timeout: 10, readiness: new Promise(() => {}) }));
    assert.ok(readinessExpired instanceof errors.TimeoutError);
    assert.match(readinessExpired.message, /before driver acceptance/);
    await assertSelectedCaller(readinessExpired, firstFixture);
    assert.equal(peer.commands.length, commandCount);
    const dispatchExpired = await captureError(() => firstHelper(client, { timeout: 0.25 }));
    assert.ok(dispatchExpired instanceof errors.TimeoutError);
    assert.match(dispatchExpired.message, /before dispatch/);
    await assertSelectedCaller(dispatchExpired, firstFixture);
    assert.equal(peer.commands.length, commandCount);
    checks.push('accepted cancellation, readiness expiry, and exhausted dispatch budget retain each original caller');

    const largeMessage = 'Original diagnostic '.repeat(4000) + '\uD800\0\uDC00';
    const large = await captureError(() => firstHelper(client, { message: largeMessage }));
    assert.equal(large.message, 'locator.click: ' + largeMessage);
    assert.equal(large.details.message, largeMessage);
    assert.ok(large.stack.length <= 32768);
    assert.match(large.stack, /Command stack truncated/);
    await assertSelectedCaller(large, firstFixture, [], false);
    checks.push('oversized diagnostics keep public message and details intact while bounding attributed stack');
  });

  await withClient(async (client, peer) => {
    const firstResult = firstHelper(client, { mode: 'hold' }).then(() => assert.fail('pending command must fail'), error => error);
    const secondResult = secondHelper(client, { mode: 'hold' }).then(() => assert.fail('pending command must fail'), error => error);
    await waitForAcceptedCommands(peer, 2);
    peer.disconnect();
    const shared = client.failure;
    const originalStack = shared.stack;
    const [firstError, secondError] = await Promise.all([firstResult, secondResult]);
    for (const error of [firstError, secondError]) {
      assert.ok(error instanceof errors.BrowserDisconnectedError);
      assert.notEqual(error, shared);
      assert.equal(error.details, shared.details);
      assert.equal(error.message, shared.message);
    }
    assert.notEqual(firstError, secondError);
    assert.equal(client.failure, shared);
    assert.equal(shared.stack, originalStack);
    await assertSelectedCaller(firstError, firstFixture);
    await assertSelectedCaller(secondError, secondFixture);
    checks.push('shared clean transport closure attributes concurrent helpers independently without mutating shared failure');
  });

  await withClient(async (client, peer) => {
    const firstResult = firstHelper(client, { mode: 'hold' }).then(() => assert.fail('pending command must fail'), error => error);
    const secondResult = secondHelper(client, { mode: 'hold' }).then(() => assert.fail('pending command must fail'), error => error);
    await waitForAcceptedCommands(peer, 2);
    const externalError = Object.assign(new Error('original external transport failure'), { code: 'EIO' });
    client.rejectProtocol(externalError);
    peer.disconnect();
    const results = await Promise.all([firstResult, secondResult]);
    assert.equal(results[0], externalError);
    assert.equal(results[1], externalError);
    assert.equal(client.failure, externalError);
    checks.push('unknown external errors preserve object identity across every pending request');
  });

  const record = { code: 'TargetClosedError', method: 'locator.click', message: 'unchanged record' };
  const originalRecordError = errors.fromRecord(record);
  const attributedRecordError = errors.fromRecord(record, callers.callerStack());
  assert.equal(attributedRecordError.details, record);
  assert.equal(attributedRecordError.message, originalRecordError.message);
  assert.equal(attributedRecordError.constructor, originalRecordError.constructor);
  class CustomTransportError extends errors.BrowserDisconnectedError {}
  const custom = new CustomTransportError({ code: 'BrowserDisconnectedError', method: 'engine', message: 'custom error' });
  Object.defineProperty(custom, 'details', { get() { assert.fail('unknown subclass must not be inspected for cloning'); } });
  const syntheticCaller = `Error\n    at helper (${join(fixtureDirectory, 'application.ts')}:1:1)`;
  assert.equal(errors.attributeRequestFailure(custom, syntheticCaller), custom);
  const canonical = errors.failure('BrowserDisconnectedError', 'engine', 'canonical error');
  const cause = new Error('original cause');
  Object.defineProperty(canonical, 'cause', { value: cause, enumerable: false, writable: false, configurable: false });
  const attributed = errors.attributeRequestFailure(canonical, syntheticCaller);
  assert.notEqual(attributed, canonical);
  assert.deepEqual(Object.getOwnPropertyDescriptor(attributed, 'cause'), Object.getOwnPropertyDescriptor(canonical, 'cause'));
  checks.push('canonical factory retains record/class/message and cause descriptor; unknown subclasses remain unchanged');
  console.log(JSON.stringify({ status: 'passed', runtime: process.versions.bun ?? process.versions.node, checks, nativeOrBrowserExecution: false }, null, 2));
} finally {
  Error.prepareStackTrace = previousFormatter;
  removeMapper();
  if (previousCacheDirectory === undefined) delete process.env.PWTEST_CACHE_DIR;
  else process.env.PWTEST_CACHE_DIR = previousCacheDirectory;
  await rm(fixtureDirectory, { recursive: true, force: true });
}
