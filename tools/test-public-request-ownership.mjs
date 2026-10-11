import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'flashwright';
import { createHttpFixture } from './http-fixture.mjs';

assert.ok(process.env.FLASHWRIGHT_DRIVER_PATH, 'Select a verified native driver');
const require = createRequire(import.meta.url);
const { installRunnerContextDefaults } = require('../packages/flashwright-core/dist/commonjs/runner-context-defaults.js');
const { installArtifactRequestLifecycle } = require('../packages/flashwright-core/dist/commonjs/runner-request-lifecycle.js');
const directory = await mkdtemp(join(tmpdir(), 'flashwright-request-ownership-'));
const fixture = createHttpFixture((incoming, outgoing) => {
  outgoing.setHeader('content-type', 'application/json');
  outgoing.end(JSON.stringify({ userAgent: incoming.headers['user-agent'], cookie: incoming.headers.cookie ?? '' }));
});
let restoreDefaults;
let registration;
let retirement;
let context;
let creation;
let releaseEnrollment;
const enrollmentGate = new Promise(resolve => { releaseEnrollment = resolve; });
let enrollmentStarted;
const started = new Promise(resolve => { enrollmentStarted = resolve; });
const events = [];

try {
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  const origin = `http://127.0.0.1:${fixture.server.address().port}`;
  const storagePath = join(directory, 'original-storage.json');
  await writeFile(storagePath, JSON.stringify({ cookies: [{ name: 'scope', value: 'original', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
  restoreDefaults = installRunnerContextDefaults({
    contextOptions: { baseURL: origin, userAgent: 'OriginalScope/1.0', storageState: storagePath, viewport: { width: 360, height: 240 }, hasTouch: true },
    actionTimeout: 0, navigationTimeout: 0,
  });
  registration = installArtifactRequestLifecycle({
    beginRequestCreation() {
      events.push('original-claim');
      return {
        async didCreateContext(created) {
          context = created;
          events.push('original-enrollment');
          enrollmentStarted();
          await enrollmentGate;
        },
        complete() { events.push('original-completion'); },
      };
    },
    didCreateUnclaimedContext() { throw new Error('Original creation became unclaimed'); },
    async willDisposeContext() { events.push('context-dispose'); },
    async didCloseContext() { events.push('context-close'); },
  });
  creation = request.newContext();
  void creation.catch(() => {});
  assert.deepEqual(events, ['original-claim']);
  restoreDefaults();
  restoreDefaults = installRunnerContextDefaults({
    contextOptions: { baseURL: 'http://invalid.example.test', userAgent: 'SuccessorScope/2.0', storageState: { cookies: [], origins: [] } },
    actionTimeout: 20, navigationTimeout: 0,
  });
  let retired = false;
  retirement = registration.dispose().then(() => { retired = true; });
  await Promise.race([started, creation]);
  assert.equal(retired, false, 'Original registration must await its native context enrollment');
  assert.deepEqual(events, ['original-claim', 'original-enrollment']);
  releaseEnrollment();
  context = await creation;
  await retirement;
  assert.equal(retired, true);
  assert.deepEqual(events, ['original-claim', 'original-enrollment', 'original-completion']);
  assert.deepEqual(await (await context.get('/inspect')).json(), { userAgent: 'OriginalScope/1.0', cookie: 'scope=original' });
  await Promise.all([context.dispose(), context.dispose()]);
  await assert.rejects(context.get('/inspect'), /disposed|closed/i);
  console.log(JSON.stringify({ status: 'passed', checks: ['synchronous original claim', 'defaults captured before storage preparation awaits', 'native publication stays with retiring owner', 'successor defaults do not replace original URL user agent cookies or timeout', 'public context disposes once'] }));
} finally {
  releaseEnrollment();
  restoreDefaults?.();
  context ??= await creation?.catch(() => undefined);
  await context?.dispose();
  await retirement;
  await registration?.dispose();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
