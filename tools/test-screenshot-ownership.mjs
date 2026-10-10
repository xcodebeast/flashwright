import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import filesystem from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import typescript from 'typescript';

const require = createRequire(import.meta.url);
let observer;
const runnerIntegration = {
  runInternal(_version, callback) { return callback(); },
  installArtifactContextLifecycle(version, lifecycle) {
    assert.equal(version, 9);
    assert.equal(observer, undefined);
    observer = lifecycle;
    return { ready: Promise.resolve(), async dispose() { observer = undefined; } };
  },
};
async function loadModule(relativePath, replacements = {}) {
  const path = resolve(relativePath);
  const compiled = typescript.transpileModule(await filesystem.readFile(path, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
    fileName: path, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.length, 0);
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    exports: module.exports, module, Buffer, process, Set,
    require: name => replacements[name] ?? require(name),
  }, { filename: path });
  return module.exports;
}
const artifactErrors = await loadModule('packages/flashwright-runner/src/artifact-errors.ts');
const { ScreenshotScopes, ScreenshotLifecycle } = await loadModule('packages/flashwright-runner/src/screenshot-recorder.ts', {
  '@flashwright/core': { failure(name, operation, message) { return Object.assign(Error(`${operation}: ${message}`), { name }); } },
  '@flashwright/core/runner-integration': { runnerIntegration },
  './artifact-errors.js': artifactErrors,
});
const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-screenshot-ownership-'));
const policy = { mode: 'only-on-failure', options: {} };
const report = { status: 'running', runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, checks: [] };
const captures = [];
let nextAttempt = 0;
function information() {
  const outputDir = join(directory, `attempt-${++nextAttempt}`);
  return {
    status: 'failed', expectedStatus: 'passed', retry: 0,
    project: { outputDir: directory }, outputDir, attachments: [],
    _onDidFinishTestFunctionCallbacks: new Set(), outputPath: name => join(outputDir, name),
  };
}
function page(label, wait) {
  return { async screenshot(options) {
    captures.push(label);
    assert.equal(options.caret, 'initial');
    assert.ok(options.timeout > 0 && options.timeout <= 5000);
    await wait?.();
    await filesystem.mkdir(dirname(options.path), { recursive: true });
    await filesystem.writeFile(options.path, label);
    return Buffer.from(label);
  } };
}
function context(...pages) { return Object.assign(new EventEmitter(), { pages: () => pages }); }
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
async function check(name, callback) { await callback(); report.checks.push(name); }
async function images(info) {
  assert.ok(info.attachments.every(attachment => attachment.name === 'screenshot'));
  return Promise.all(info.attachments.map(attachment => filesystem.readFile(attachment.path, 'utf8')));
}

try {
  await check('late original creation and closure cannot publish screenshots on a successor scope', async () => {
    const available = new Set();
    const scopes = new ScreenshotScopes(policy, available);
    const originalInfo = information();
    const successorInfo = information();
    const originalRecorder = scopes.start(originalInfo);
    const oldClaim = scopes.claim();
    await scopes.finish(originalRecorder);
    const successorRecorder = scopes.start(successorInfo);
    const oldContext = context(page('late original'));
    available.add(oldContext);
    oldClaim.didCreateContext(oldContext);
    const successorContext = context(page('successor'));
    available.add(successorContext);
    scopes.claim().didCreateContext(successorContext);
    await scopes.beforeContextClose(oldContext);
    available.delete(oldContext);
    await scopes.finish(successorRecorder);
    assert.deepEqual(await images(originalInfo), []);
    assert.deepEqual(await images(successorInfo), ['successor']);
  });

  await check('explicit next-attempt adoption gives a surviving context its new screenshot owner', async () => {
    const shared = context(page('surviving page'));
    const available = new Set([shared]);
    const scopes = new ScreenshotScopes(policy, available);
    const originalInfo = information();
    const successorInfo = information();
    const originalRecorder = scopes.start(originalInfo);
    const originalClaim = scopes.claim();
    await scopes.finish(originalRecorder);
    const successorRecorder = scopes.start(successorInfo);
    originalClaim.didCreateContext(shared);
    await scopes.beforeContextClose(shared);
    available.delete(shared);
    await scopes.finish(successorRecorder);
    assert.deepEqual(await images(originalInfo), ['surviving page']);
    assert.deepEqual(await images(successorInfo), ['surviving page']);
  });

  await check('repeated hook scopes share captured-page identity while newly created pages retain the same TestInfo', async () => {
    const firstPage = page('first hook page');
    const pages = [firstPage];
    const shared = { pages: () => pages };
    const scopes = new ScreenshotScopes(policy, new Set([shared]));
    const info = information();
    const firstRecorder = scopes.start(info);
    const oldClaim = scopes.claim();
    await scopes.finish(firstRecorder);
    pages.push(page('later hook page'));
    const laterRecorder = scopes.start(info);
    oldClaim.didCreateContext(shared);
    for (const callback of [...info._onDidFinishTestFunctionCallbacks]) await callback();
    await scopes.beforeContextClose(shared);
    await scopes.finish(laterRecorder);
    assert.deepEqual(await images(info), ['first hook page', 'later hook page']);
    assert.equal(info._onDidFinishTestFunctionCallbacks.size, 0);
  });

  await check('finished scopes release context ownership and reject later capture admission', async () => {
    const subject = context(page('finished owner'));
    const available = new Set([subject]);
    const scopes = new ScreenshotScopes(policy, available);
    const info = information();
    const recorder = scopes.start(info);
    const claim = scopes.claim();
    await scopes.finish(recorder);
    assert.equal(scopes.claim(), undefined);
    const capturesBefore = captures.length;
    claim.didCreateContext(context(page('released late claim')));
    await scopes.beforeContextClose(subject);
    assert.equal(captures.length, capturesBefore);
    assert.deepEqual(await images(info), ['finished owner']);
  });

  await check('already admitted old close work remains original-owned during successor capture', async () => {
    const started = deferred();
    const release = deferred();
    const oldContext = context(page('original pending close', async () => { started.resolve(); await release.promise; }));
    const available = new Set([oldContext]);
    const scopes = new ScreenshotScopes(policy, available);
    const originalInfo = information();
    const successorInfo = information();
    const originalRecorder = scopes.start(originalInfo);
    const closing = scopes.beforeContextClose(oldContext);
    await started.promise;
    available.delete(oldContext);
    const finishing = scopes.finish(originalRecorder);
    const successorContext = context(page('successor during cleanup'));
    available.add(successorContext);
    const successorRecorder = scopes.start(successorInfo);
    await scopes.finish(successorRecorder);
    release.resolve();
    await Promise.all([closing, finishing]);
    assert.deepEqual(await images(originalInfo), ['original pending close']);
    assert.deepEqual(await images(successorInfo), ['successor during cleanup']);
  });

  await check('standalone lifecycle captures creation ownership before publication and preserves browser-close omission', async () => {
    const lifecycle = new ScreenshotLifecycle(policy);
    try {
      await lifecycle.ready;
      const originalInfo = information();
      const successorInfo = information();
      const originalRecorder = lifecycle.start(originalInfo);
      const originalCreation = observer.beginContextCreation();
      await lifecycle.finish(originalRecorder);
      const successorRecorder = lifecycle.start(successorInfo);
      const originalContext = context(page('standalone late original'));
      await originalCreation.didCreateContext(originalContext);
      originalCreation.complete();
      await observer.willCloseContext(originalContext, 'context');
      originalContext.emit('close');
      const successorCreation = observer.beginContextCreation();
      const successorContext = context(page('standalone successor'));
      await successorCreation.didCreateContext(successorContext);
      successorCreation.complete();
      await observer.willCloseContext(successorContext, 'browser');
      successorContext.emit('close');
      await lifecycle.finish(successorRecorder);
      assert.deepEqual(await images(originalInfo), []);
      assert.deepEqual(await images(successorInfo), []);
      assert.equal(captures.includes('standalone late original'), false);
      assert.equal(captures.includes('standalone successor'), false);
    } finally { await lifecycle.dispose(); }
    assert.equal(observer, undefined);
  });

  report.status = 'passed';
  console.log(JSON.stringify(report, null, 2));
} finally { await filesystem.rm(directory, { recursive: true, force: true }); }
