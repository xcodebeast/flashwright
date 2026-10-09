import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';

const require = createRequire(resolve('packages/flashwright-core/package.json'));
const { Browser } = require(resolve('packages/flashwright-core/dist/commonjs/index.js'));
const { runnerIntegration } = require(resolve('packages/flashwright-core/dist/commonjs/runner-integration.js'));
const { didCreateRunnerContext } = require(resolve('packages/flashwright-core/dist/commonjs/runner-lifecycle.js'));
const filesystem = require('node:fs/promises');
const report = { status: 'running', checks: [] };
let nextBrowser = 0;

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** Real host lifecycle objects with a controlled native command boundary. */
function browserFixture(beforeReply) {
  const requests = [];
  const subscriptions = new Map();
  let nextContext = 0;
  const identity = `browser-${++nextBrowser}`;
  const client = {
    isClosed: () => false,
    subscribeObject(identifier, listener) { subscriptions.set(identifier, listener); return () => subscriptions.delete(identifier); },
    setConsoleSubscription() {}, async release() {},
    async request(method, parameters) {
      requests.push({ method, parameters });
      await beforeReply?.(method);
      if (method === 'browser.newContext') return { identifier: `${identity}/context-${++nextContext}` };
      return {};
    },
  };
  return { browser: new Browser(client, identity, 'controlled'), requests, subscriptions };
}

async function until(condition) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (condition()) return; await setImmediate(); }
  throw new Error('controlled artifact lifecycle did not reach its boundary');
}

async function check(name, callback) {
  await callback();
  report.checks.push(name);
}

try {
  await check('disabled and synchronous observers retain the original native command sequence', async () => {
    const fixture = browserFixture();
    try {
      const first = await fixture.browser.newContext();
      assert.equal(didCreateRunnerContext(first), undefined);
      const observed = [];
      const uninstall = runnerIntegration.installContextLifecycle(1, {
        didCreateContext(context) { observed.push(context); }, async willCloseContext() {},
      });
      try {
        const second = await fixture.browser.newContext();
        assert.deepEqual(observed, [first, second]);
        assert.equal(didCreateRunnerContext(second), undefined);
        assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'browser.newContext']);
      } finally { uninstall(); }
    } finally { await fixture.browser.close(); }
  });

  await check('new context publication awaits its one artifact enrollment', async () => {
    const fixture = browserFixture();
    const startup = deferred();
    const observed = [];
    const registration = runnerIntegration.installAsyncContextLifecycle(2, {
      async didCreateContext(context) { observed.push(context); await startup.promise; }, async willCloseContext() {},
    });
    try {
      await registration.ready;
      let published = false;
      const creation = fixture.browser.newContext().then(context => { published = true; return context; });
      await until(() => observed.length === 1);
      const repeated = didCreateRunnerContext(observed[0]);
      assert.equal(repeated, didCreateRunnerContext(observed[0]));
      assert.equal(published, false);
      assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext']);
      startup.resolve();
      assert.equal(await creation, observed[0]);
      await repeated;
      assert.equal(observed.length, 1);
    } finally { startup.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('existing and concurrently created contexts share identity and startup ownership', async () => {
    const fixture = browserFixture();
    const first = await fixture.browser.newContext();
    const startup = deferred();
    const observed = [];
    const registration = runnerIntegration.installAsyncContextLifecycle(2, {
      async didCreateContext(context) { observed.push(context); await startup.promise; }, async willCloseContext() {},
    });
    try {
      let ready = false;
      const readiness = registration.ready.then(() => { ready = true; });
      const creation = fixture.browser.newContext();
      await until(() => observed.length === 2);
      const repeated = didCreateRunnerContext(first);
      assert.equal(ready, false);
      assert.equal(observed.filter(context => context === first).length, 1);
      startup.resolve();
      await Promise.all([readiness, creation, repeated]);
      assert.equal(observed.length, 2);
    } finally { startup.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('failed startup preserves its exact error and closes its native context', async () => {
    const fixture = browserFixture();
    const original = new Error('original artifact startup failure');
    let closes = 0;
    const registration = runnerIntegration.installAsyncContextLifecycle(2, {
      async didCreateContext() { throw original; },
      async willCloseContext() { closes++; throw new Error('secondary cleanup callback failure'); },
    });
    try {
      await registration.ready;
      await assert.rejects(fixture.browser.newContext(), error => error === original);
      assert.equal(closes, 1);
      assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'context.close']);
      assert.equal(fixture.browser.contexts().length, 0);
    } finally { await registration.dispose(); await fixture.browser.close(); }
  });

  await check('concurrent close waits for startup and rejects publication of a closing context', async () => {
    const fixture = browserFixture();
    const startup = deferred();
    let enrolled;
    let closes = 0;
    const registration = runnerIntegration.installAsyncContextLifecycle(2, {
      async didCreateContext(context) { enrolled = context; await startup.promise; },
      async willCloseContext() { closes++; },
    });
    try {
      await registration.ready;
      const creation = fixture.browser.newContext();
      const rejected = assert.rejects(creation, error => error.name === 'TargetClosedError');
      await until(() => enrolled);
      const closure = enrolled.close();
      assert.equal(enrolled.close(), closure);
      await setImmediate();
      assert.equal(closes, 0);
      assert.equal(fixture.requests.length, 1);
      startup.resolve();
      await Promise.all([closure, rejected]);
      assert.equal(closes, 1);
      assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'context.close']);
    } finally { startup.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('browser destruction while startup waits cannot publish its dead context', async () => {
    const fixture = browserFixture();
    const startup = deferred();
    let entered = false;
    const registration = runnerIntegration.installAsyncContextLifecycle(2, {
      async didCreateContext() { entered = true; await startup.promise; }, async willCloseContext() {},
    });
    try {
      await registration.ready;
      const rejected = assert.rejects(fixture.browser.newContext(), error => error.name === 'TargetClosedError');
      await until(() => entered);
      await fixture.browser.close();
      startup.resolve();
      await rejected;
      assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'browser.close']);
    } finally { startup.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('teardown retains pending startup and close ownership before permitting a successor', async () => {
    const fixture = browserFixture();
    const startup = deferred();
    const closeGate = deferred();
    let enrolled;
    let closeEntered = false;
    const registration = runnerIntegration.installAsyncContextLifecycle(2, {
      async didCreateContext(context) { enrolled = context; await startup.promise; },
      async willCloseContext() { closeEntered = true; await closeGate.promise; },
    });
    try {
      await registration.ready;
      const rejected = assert.rejects(fixture.browser.newContext(), error => error.name === 'TargetClosedError');
      await until(() => enrolled);
      const closure = enrolled.close();
      let disposed = false;
      const disposal = registration.dispose();
      assert.equal(disposal, registration.dispose());
      void disposal.then(() => { disposed = true; });
      assert.throws(() => runnerIntegration.installContextLifecycle(1, { didCreateContext() {}, async willCloseContext() {} }), /already active/);
      startup.resolve();
      await until(() => closeEntered);
      assert.equal(disposed, false);
      assert.throws(() => runnerIntegration.installAsyncContextLifecycle(2, { async didCreateContext() {}, async willCloseContext() {} }), /already active/);
      closeGate.resolve();
      await Promise.all([closure, rejected, disposal]);
      const successor = runnerIntegration.installAsyncContextLifecycle(2, { async didCreateContext() {}, async willCloseContext() {} });
      await successor.ready;
      await successor.dispose();
    } finally { startup.resolve(); closeGate.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('retiring registration rejects new admission and still cleans that allocation', async () => {
    const fixture = browserFixture();
    const startup = deferred();
    let entered = false;
    const registration = runnerIntegration.installAsyncContextLifecycle(2, {
      async didCreateContext() { entered = true; await startup.promise; }, async willCloseContext() {},
    });
    try {
      await registration.ready;
      const originalCreation = fixture.browser.newContext();
      await until(() => entered);
      const disposal = registration.dispose();
      await assert.rejects(fixture.browser.newContext(), error => error.name === 'ProtocolError' && /retiring/.test(error.message));
      assert.equal(fixture.browser.contexts().length, 1);
      startup.resolve();
      await Promise.all([originalCreation, disposal]);
      assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'browser.newContext', 'context.close']);
    } finally { startup.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('failed adoption of existing contexts waits for every admitted callback before detaching', async () => {
    const fixture = browserFixture();
    const first = await fixture.browser.newContext();
    await fixture.browser.newContext();
    const startup = deferred();
    const original = new Error('existing context enrollment failed');
    let callbacks = 0;
    const registration = runnerIntegration.installAsyncContextLifecycle(2, {
      async didCreateContext(context) { callbacks++; if (context === first) throw original; await startup.promise; },
      async willCloseContext() {},
    });
    try {
      let finished = false;
      const readiness = assert.rejects(registration.ready, error => error === original).then(() => { finished = true; });
      await until(() => callbacks === 2);
      assert.equal(finished, false);
      assert.throws(() => runnerIntegration.installContextLifecycle(1, { didCreateContext() {}, async willCloseContext() {} }), /already active/);
      startup.resolve();
      await readiness;
      const uninstall = runnerIntegration.installContextLifecycle(1, { didCreateContext() {}, async willCloseContext() {} });
      uninstall();
    } finally { startup.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('recursive creation and closure callbacks reject without losing native context cleanup', async () => {
    for (const phase of ['creation', 'closure']) {
      const fixture = browserFixture();
      const registration = runnerIntegration.installAsyncContextLifecycle(2, {
        async didCreateContext(context) { if (phase === 'creation') await context.close(); },
        async willCloseContext(context) { if (phase === 'closure') await context.close(); },
      });
      try {
        await registration.ready;
        const work = phase === 'creation' ? fixture.browser.newContext() : (await fixture.browser.newContext()).close();
        await assert.rejects(work, error => error.name === 'ProtocolError' && /recursively/.test(error.message));
        assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'context.close']);
        assert.equal(fixture.browser.contexts().length, 0);
      } finally { await registration.dispose(); await fixture.browser.close(); }
    }
  });

  await check('recursive observer disposal rejects from creation and close callbacks', async () => {
    for (const phase of ['creation', 'closure']) {
      const fixture = browserFixture();
      const registration = runnerIntegration.installAsyncContextLifecycle(2, {
        async didCreateContext() { if (phase === 'creation') await registration.dispose(); },
        async willCloseContext() { if (phase === 'closure') await registration.dispose(); },
      });
      try {
        await registration.ready;
        const work = phase === 'creation' ? fixture.browser.newContext() : (await fixture.browser.newContext()).close();
        await assert.rejects(work, error => error.name === 'ProtocolError' && /recursively/.test(error.message));
        assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'context.close']);
      } finally { await registration.dispose(); await fixture.browser.close(); }
    }
  });

  await check('nested context creation rejects before allocation inside artifact callbacks', async () => {
    for (const phase of ['creation', 'closure']) {
      const fixture = browserFixture();
      const registration = runnerIntegration.installAsyncContextLifecycle(2, {
        async didCreateContext() { if (phase === 'creation') await fixture.browser.newContext(); },
        async willCloseContext() { if (phase === 'closure') await fixture.browser.newContext(); },
      });
      try {
        await registration.ready;
        const work = phase === 'creation' ? fixture.browser.newContext() : (await fixture.browser.newContext()).close();
        await assert.rejects(work, error => error.name === 'ProtocolError' && /creation.*recursively/.test(error.message));
        assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'context.close']);
        assert.equal(fixture.browser.contexts().length, 0);
      } finally { await registration.dispose(); await fixture.browser.close(); }
    }
  });

  await check('late native allocations cannot enter a successor artifact scope in either off transition', async () => {
    for (const [oldEnabled, newEnabled] of [[true, true], [true, false], [false, true]]) {
      const nativeReply = deferred();
      let requested = false;
      const fixture = browserFixture(async method => { if (method === 'browser.newContext') { requested = true; await nativeReply.promise; } });
      const observed = [];
      const observer = { async didCreateContext(context) { observed.push(context); }, async willCloseContext() { throw new Error('unadmitted context reached a successor close callback'); } };
      const previous = oldEnabled ? runnerIntegration.installAsyncContextLifecycle(2, observer) : undefined;
      let successor;
      try {
        await previous?.ready;
        const rejected = assert.rejects(fixture.browser.newContext(), error => error.name === 'TargetClosedError' && /scope changed/.test(error.message));
        await until(() => requested);
        await previous?.dispose();
        if (newEnabled) { successor = runnerIntegration.installAsyncContextLifecycle(2, observer); await successor.ready; }
        nativeReply.resolve();
        await rejected;
        assert.equal(observed.length, 0);
        assert.equal(fixture.browser.contexts().length, 0);
        assert.deepEqual(fixture.requests.map(value => value.method), ['browser.newContext', 'context.close']);
      } finally { nativeReply.resolve(); await previous?.dispose(); await successor?.dispose(); await fixture.browser.close(); }
    }
  });

  await check('version and shape validation cannot replace an installed lifecycle', async () => {
    assert.throws(() => runnerIntegration.installAsyncContextLifecycle(1, {}), error => error.name === 'ProtocolError');
    assert.throws(() => runnerIntegration.installAsyncContextLifecycle(2, {}), error => error.name === 'ProtocolError');
    assert.throws(() => runnerIntegration.installContextLifecycle(2, {}), error => error.name === 'ProtocolError');
    const registration = runnerIntegration.installAsyncContextLifecycle(2, { async didCreateContext() {}, async willCloseContext() {} });
    await registration.ready;
    await registration.dispose();
    await registration.dispose();
  });

  await check('owned creation captures the original attempt before a native reply crosses into its successor', async () => {
    const nativeReply = deferred();
    const fixture = browserFixture(method => method === 'browser.newContext' ? nativeReply.promise : undefined);
    let current = { title: 'original' };
    const claims = []; const enrolled = []; const completed = [];
    const registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() {
        const owner = current; claims.push(owner);
        return { async didCreateContext(context) { enrolled.push({ owner, context }); }, complete() { completed.push(owner); } };
      },
      async willCloseContext() {},
    });
    try {
      await registration.ready;
      const original = current;
      const creation = fixture.browser.newContext();
      assert.deepEqual(claims, [original], 'claim is synchronous, before native completion');
      current = { title: 'successor' };
      nativeReply.resolve();
      const context = await creation;
      assert.deepEqual(enrolled, [{ owner: original, context }]); assert.deepEqual(completed, [original]);
      const successor = await fixture.browser.newContext();
      assert.deepEqual(enrolled, [{ owner: original, context }, { owner: current, context: successor }]);
      assert.deepEqual(completed, [original, current]);
    } finally { nativeReply.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('existing contexts claim their registration attempt before asynchronous enrollment', async () => {
    const fixture = browserFixture();
    const context = await fixture.browser.newContext();
    let current = 'original'; let claims = 0; let completions = 0; const enrolled = [];
    const registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() { const owner = current; claims++; return { async didCreateContext(value) { enrolled.push([owner, value]); }, complete() { completions++; } }; },
      async willCloseContext() {},
    });
    try {
      assert.equal(claims, 1); current = 'successor'; await registration.ready;
      await didCreateRunnerContext(context); await didCreateRunnerContext(context);
      assert.deepEqual(enrolled, [['original', context]]); assert.equal(claims, 1); assert.equal(completions, 1);
    } finally { await registration.dispose(); await fixture.browser.close(); }
  });

  await check('storage preparation retains the attempt claimed before its asynchronous read', async () => {
    const fixture = browserFixture(); const storage = deferred(); let current = 'original'; const enrolled = [];
    const originalRead = filesystem.readFile;
    const registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() { const owner = current; return { async didCreateContext() { enrolled.push(owner); }, complete() {} }; },
      async willCloseContext() {},
    });
    try {
      await registration.ready;
      filesystem.readFile = async (path, ...arguments_) => path === 'delayed-state.json' ? storage.promise : originalRead(path, ...arguments_);
      const creation = fixture.browser.newContext({ storageState: 'delayed-state.json' });
      assert.equal(fixture.requests.length, 0); current = 'successor';
      storage.resolve('{"cookies":[],"origins":[]}'); await creation;
      assert.deepEqual(enrolled, ['original']);
    } finally { storage.resolve('{"cookies":[],"origins":[]}'); filesystem.readFile = originalRead; await registration.dispose(); await fixture.browser.close(); }
  });

  await check('owned creation completes validation, storage and native failures exactly once without enrollment', async () => {
    const nativeFailure = new Error('original native failure');
    const fixture = browserFixture(() => { throw nativeFailure; });
    let claims = 0; let completions = 0;
    const registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() { claims++; return { async didCreateContext() { throw Error('failed creation must not enroll'); }, complete() { completions++; } }; },
      async willCloseContext() {},
    });
    try {
      await registration.ready;
      await assert.rejects(fixture.browser.newContext({ viewport: { width: -1, height: 10 } }), { name: 'InvalidArgumentError' });
      assert.equal(completions, 1); assert.equal(fixture.requests.length, 0);
      await assert.rejects(fixture.browser.newContext({ storageState: '/no-such-flashwright-creation-state.json' }));
      assert.equal(completions, 2); assert.equal(fixture.requests.length, 0);
      await assert.rejects(fixture.browser.newContext(), error => error === nativeFailure);
      assert.equal(claims, 3); assert.equal(completions, 3); assert.equal(fixture.requests.length, 1);
    } finally { await registration.dispose(); await fixture.browser.close().catch(() => {}); }
  });

  await check('owned observer retirement retains a pending native creation through its failed-context cleanup', async () => {
    const nativeReply = deferred(); const nativeClose = deferred();
    const fixture = browserFixture(method => method === 'browser.newContext' ? nativeReply.promise : method === 'context.close' ? nativeClose.promise : undefined);
    let claims = 0; let completions = 0; let enrollments = 0;
    const observer = {
      beginContextCreation() { claims++; return { async didCreateContext() { enrollments++; }, complete() { completions++; } }; },
      async willCloseContext() {},
    };
    const registration = runnerIntegration.installOwnedContextLifecycle(8, observer);
    try {
      await registration.ready;
      const rejected = assert.rejects(fixture.browser.newContext(), /observer is retiring/);
      assert.equal(claims, 1);
      let disposed = false; const disposal = registration.dispose().then(() => { disposed = true; });
      await setImmediate(); assert.equal(disposed, false); assert.equal(completions, 0);
      await assert.rejects(fixture.browser.newContext(), /observer is retiring/);
      assert.equal(claims, 1); assert.equal(fixture.requests.length, 1, 'new admission fails before native creation');
      assert.throws(() => runnerIntegration.installOwnedContextLifecycle(8, observer), /already active/);
      nativeReply.resolve(); await until(() => fixture.requests.some(value => value.method === 'context.close'));
      assert.equal(disposed, false); assert.equal(completions, 0); assert.equal(enrollments, 0);
      nativeClose.resolve(); await Promise.all([rejected, disposal]); assert.equal(completions, 1);
      const successor = runnerIntegration.installOwnedContextLifecycle(8, observer); await successor.ready;
      await fixture.browser.newContext(); await successor.dispose(); assert.equal(enrollments, 1); assert.equal(completions, 2);
    } finally { nativeReply.resolve(); nativeClose.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('failed owned enrollment keeps its exact original failure and claim until native close settles', async () => {
    const nativeClose = deferred();
    const fixture = browserFixture(method => method === 'context.close' ? nativeClose.promise : undefined);
    const original = new Error('original owned enrollment'); let completions = 0;
    const registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() { return { async didCreateContext() { throw original; }, complete() { completions++; } }; },
      async willCloseContext() { throw Error('secondary close callback'); },
    });
    try {
      await registration.ready;
      const rejected = assert.rejects(fixture.browser.newContext(), error => error === original);
      await until(() => fixture.requests.some(value => value.method === 'context.close'));
      assert.equal(completions, 0);
      let disposed = false; const disposal = registration.dispose().then(() => { disposed = true; });
      await setImmediate(); assert.equal(disposed, false);
      nativeClose.resolve(); await Promise.all([rejected, disposal]);
      assert.equal(completions, 1); assert.equal(fixture.browser.contexts().length, 0);
    } finally { nativeClose.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('browser closure before the native reply retains its claim through late native disposal', async () => {
    const nativeReply = deferred(); const nativeClose = deferred();
    const fixture = browserFixture(method => method === 'browser.newContext' ? nativeReply.promise : method === 'context.close' ? nativeClose.promise : undefined);
    let completions = 0;
    const registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() { return { async didCreateContext() { throw Error('dead context must not enroll'); }, complete() { completions++; } }; },
      async willCloseContext() {},
    });
    try {
      await registration.ready;
      const rejected = assert.rejects(fixture.browser.newContext(), { name: 'TargetClosedError' });
      await fixture.browser.close(); nativeReply.resolve();
      await until(() => fixture.requests.some(value => value.method === 'context.close'));
      assert.equal(completions, 0); nativeClose.resolve(); await rejected; assert.equal(completions, 1);
    } finally { nativeReply.resolve(); nativeClose.resolve(); await registration.dispose(); await fixture.browser.close(); }
  });

  await check('completion failures surface at observer disposal and never replace creation outcomes', async () => {
    const fixture = browserFixture(); const original = new Error('first completion failure'); let calls = 0;
    const registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() { return { async didCreateContext() {}, complete() { calls++; throw calls === 1 ? original : Error('later completion'); } }; },
      async willCloseContext() {},
    });
    try {
      await registration.ready;
      const context = await fixture.browser.newContext(); assert.ok(fixture.browser.contexts().includes(context));
      await assert.rejects(fixture.browser.newContext({ viewport: null, unknown: true }), { name: 'UnsupportedFeatureError' });
      assert.equal(calls, 2); await assert.rejects(registration.dispose(), error => error === original);
      const successor = runnerIntegration.installOwnedContextLifecycle(8, { beginContextCreation() { return { async didCreateContext() {}, complete() {} }; }, async willCloseContext() {} });
      await successor.ready; await successor.dispose();
    } finally { await registration.dispose().catch(() => {}); await fixture.browser.close(); }
  });

  await check('asynchronous claim completion retains retirement custody and its original failure', async () => {
    const fixture = browserFixture(); const cleanup = deferred(); const original = new Error('asynchronous original completion');
    const registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() { return { async didCreateContext() {}, async complete() { await cleanup.promise; throw original; } }; },
      async willCloseContext() {},
    });
    try {
      await registration.ready; const context = await fixture.browser.newContext();
      assert.ok(fixture.browser.contexts().includes(context));
      let disposed = false; const disposal = assert.rejects(registration.dispose(), error => error === original).then(() => { disposed = true; });
      await setImmediate(); assert.equal(disposed, false);
      assert.throws(() => runnerIntegration.installContextLifecycle(1, { didCreateContext() {}, async willCloseContext() {} }), /already active/);
      cleanup.resolve(); await disposal;
    } finally { cleanup.resolve(); await registration.dispose().catch(() => {}); await fixture.browser.close(); }
  });

  await check('invalid existing-context claims and failed callbacks detach without losing the original adoption failure', async () => {
    const fixture = browserFixture(); await fixture.browser.newContext();
    const original = new Error('original existing enrollment');
    for (const invalidClaim of [true, false]) {
      const registration = runnerIntegration.installOwnedContextLifecycle(8, {
        beginContextCreation() { return invalidClaim ? {} : { async didCreateContext() { throw original; }, complete() { throw Error('secondary completion'); } }; },
        async willCloseContext() {},
      });
      await assert.rejects(registration.ready, error => invalidClaim ? /invalid runner context-creation owner/.test(error.message) : error === original);
      await registration.dispose().catch(() => {});
    }
    await fixture.browser.close();
  });

  await check('owned claim callbacks cannot recursively create contexts or dispose their observer', async () => {
    const fixture = browserFixture(); const rejected = []; let registration;
    registration = runnerIntegration.installOwnedContextLifecycle(8, {
      beginContextCreation() {
        rejected.push(assert.rejects(fixture.browser.newContext(), /creation.*recursively/));
        rejected.push(assert.rejects(registration.dispose(), /disposal.*recursively/));
        return { async didCreateContext() {}, complete() {
          rejected.push(assert.rejects(fixture.browser.newContext(), /creation.*recursively/));
          rejected.push(assert.rejects(registration.dispose(), /disposal.*recursively/));
        } };
      },
      async willCloseContext() {},
    });
    try {
      await registration.ready; await fixture.browser.newContext(); await Promise.all(rejected);
      assert.equal(rejected.length, 4); assert.equal(fixture.requests.length, 1);
    } finally { await registration.dispose(); await fixture.browser.close(); }
  });

  await check('owned lifecycle version and required claim shape fail before observer installation', async () => {
    for (const [version, lifecycle] of [[7, {}], [8, {}], [8, { didCreateContext() {}, async willCloseContext() {} }], [8, { beginContextCreation() {} }]]) {
      assert.throws(() => runnerIntegration.installOwnedContextLifecycle(version, lifecycle), { name: 'ProtocolError' });
    }
    const fixture = browserFixture();
    for (const claim of [undefined, {}, { complete() {} }, { didCreateContext() {} }]) {
      const registration = runnerIntegration.installOwnedContextLifecycle(8, { beginContextCreation() { return claim; }, async willCloseContext() {} });
      await registration.ready; await assert.rejects(fixture.browser.newContext(), /invalid runner context-creation owner/); await registration.dispose();
    }
    assert.equal(fixture.requests.length, 0); await fixture.browser.close();
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  if (process.env.FLASHWRIGHT_REPORT_PATH) await writeFile(process.env.FLASHWRIGHT_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
