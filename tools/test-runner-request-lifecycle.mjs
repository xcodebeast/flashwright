import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { beginRunnerRequestCreation, publishRunnerRequestContext, beforeRunnerRequestDispose, notifyRunnerRequestClosed, assertRunnerRequestDisposeAllowed, installArtifactRequestLifecycle } = require('../packages/flashwright-core/dist/commonjs/runner-request-lifecycle.js');

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

{
  const enrollment = deferred();
  const events = [];
  const registration = installArtifactRequestLifecycle({
    beginRequestCreation() {
      events.push('claim');
      return {
        async didCreateContext(context) { events.push(`enroll:${context.id}`); await enrollment.promise; },
        complete() { events.push('complete'); },
      };
    },
    didCreateUnclaimedContext(context) { events.push(`unclaimed:${context.id}`); },
    async willDisposeContext(context) { events.push(`dispose:${context.id}`); },
    async didCloseContext(context) { events.push(`close:${context.id}`); },
  });
  const claim = beginRunnerRequestCreation();
  const context = { id: 'original' };
  const publication = publishRunnerRequestContext(context, claim);
  const retirement = registration.dispose();
  let retired = false;
  void retirement.then(() => { retired = true; });
  await Promise.resolve();
  assert.equal(retired, false);
  enrollment.resolve();
  await publication;
  await beforeRunnerRequestDispose(context);
  await beforeRunnerRequestDispose(context);
  notifyRunnerRequestClosed(context);
  notifyRunnerRequestClosed(context);
  claim.complete();
  claim.complete();
  await retirement;
  assert.deepEqual(events, ['claim', 'enroll:original', 'dispose:original', 'complete', 'close:original']);
}

{
  const begunBeforeRegistration = beginRunnerRequestCreation();
  const events = [];
  const registration = installArtifactRequestLifecycle({
    beginRequestCreation() { throw new Error('late request was reassigned'); },
    async didCreateContext() { throw new Error('late request was reassigned'); },
    didCreateUnclaimedContext(context) { events.push(`unclaimed:${context.id}`); },
    async willDisposeContext(context) { events.push(`dispose:${context.id}`); },
    async didCloseContext(context) { events.push(`close:${context.id}`); },
  });
  const context = { id: 'late' };
  await publishRunnerRequestContext(context, begunBeforeRegistration);
  begunBeforeRegistration.complete();
  notifyRunnerRequestClosed(context);
  await registration.dispose();
  assert.deepEqual(events, ['unclaimed:late', 'close:late']);
}

{
  const releaseDisposal = deferred();
  const events = [];
  const registration = installArtifactRequestLifecycle({
    beginRequestCreation() {
      return { async didCreateContext() {}, complete() {} };
    },
    didCreateUnclaimedContext() {},
    async willDisposeContext() { events.push('dispose'); await releaseDisposal.promise; },
    async didCloseContext() { events.push('close'); },
  });
  const claim = beginRunnerRequestCreation();
  const context = { id: 'overlap' };
  await publishRunnerRequestContext(context, claim);
  const first = beforeRunnerRequestDispose(context);
  const second = beforeRunnerRequestDispose(context);
  notifyRunnerRequestClosed(context);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['dispose']);
  releaseDisposal.resolve();
  await Promise.all([first, second]);
  claim.complete();
  await registration.dispose();
  assert.deepEqual(events, ['dispose', 'close']);
}

{
  let registration;
  registration = installArtifactRequestLifecycle({
    beginRequestCreation() {
      assert.throws(() => beginRunnerRequestCreation(), error => error.name === 'ProtocolError');
      return { async didCreateContext() {}, complete() {} };
    },
    didCreateUnclaimedContext() {},
    async willDisposeContext() {
      assert.throws(() => assertRunnerRequestDisposeAllowed(), error => error.name === 'ProtocolError');
      await assert.rejects(registration.dispose(), error => error.name === 'ProtocolError');
    },
    async didCloseContext() {},
  });
  const claim = beginRunnerRequestCreation();
  const context = { id: 'recursive' };
  await publishRunnerRequestContext(context, claim);
  await beforeRunnerRequestDispose(context);
  notifyRunnerRequestClosed(context);
  claim.complete();
  await registration.dispose();
}

console.log(JSON.stringify({ status: 'passed', checks: ['original attempt survives retirement', 'once-only disposal and closure', 'late publication remains unclaimed', 'explicit disposal and disconnect share exact cleanup', 'recursive artifact callbacks reject without deadlock'] }));
