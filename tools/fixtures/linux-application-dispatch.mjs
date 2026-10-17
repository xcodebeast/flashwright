import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { linuxDispatchObserver } from '../final-goal-linux-dispatch.mjs';

// Invented identities and callback text: state-machine fixtures, never runtime evidence.
export function syntheticDispatch({ prepared, preparedSha256, owner, reporter, before, resources, observerOriginalPath = '/synthetic/observer.cjs', journalCount = 1 }) {
  const hash = text => createHash('sha256').update(text).digest('hex');
  owner.runnerProcess = 100;
  resources.workloadClock ??= { schemaVersion: 1, type: 'monotonic', identity: resources.captureIdentity,
    originNanoseconds: owner.clock.originNanoseconds, implementation: owner.clock.implementation, resolutionSeconds: 1e-9 };
  const commonPath = prepared.engine === 'playwright' ? posix.join(posix.dirname(prepared.runnerCommand[1]), 'lib/common/index.js')
    : posix.join(prepared.workspaceDirectory, 'packages/flashwright-runner/dist/upstream/lib/common/index.js');
  before.inputs.files.push({ path: observerOriginalPath, resolvedPath: observerOriginalPath, ...linuxDispatchObserver },
    { path: commonPath, resolvedPath: commonPath, bytes: 1, sha256: 'c'.repeat(64) });
  const specs = [];
  const visit = suite => { specs.push(...suite.specs ?? []); for (const child of suite.suites ?? []) visit(child); };
  for (const suite of reporter.suites) visit(suite);
  const sourceBodies = prepared.generatedSources.flatMap(s => s.testBodies.map(b => ({ file: s.path, ...b })));
  const registrations = sourceBodies.map((b, index) => {
    const runtimeFunctionText = `async () => { /* synthetic callback ${index} */ }`;
    return { registration: index + 1, file: b.file, line: b.line, column: 0, title: b.title,
      sourceBodySha256: b.sha256, runtimeFunctionSha256: hash(runtimeFunctionText), runtimeFunctionText };
  });
  const ownerEvents = new Map(owner.events.map(e => [e.name, e.nanoseconds]));
  const start = BigInt(ownerEvents.get('runner-spawn-requested')), end = BigInt(ownerEvents.get('runner-closed'));
  const journals = Array.from({ length: journalCount }, (_, workerIndex) => {
    const process = 200 + workerIndex, processStartTicks = '1', processIdentity = `${resources.captureIdentity}/${process}/${processStartTicks}`;
    const events = [];
    const record = (kind, data) => events.push({ sequence: events.length + 1, kind, nanoseconds: '', ...data });
    record('worker-enrolled', { processIdentity, process, parent: owner.runnerProcess, processStartTicks, workerIndex, parallelIndex: workerIndex,
      clock: { schemaVersion: 1, type: 'monotonic', identity: resources.captureIdentity, originNanoseconds: owner.clock.originNanoseconds,
        implementation: owner.clock.implementation, resolutionSeconds: 1e-9 }, preparedSha256,
      commonSha256: 'c'.repeat(64), observerSha256: linuxDispatchObserver.sha256, executable: before.inputs.executables.runtime.resolvedPath });
    for (const registration of registrations) record('callback-registered', registration);
    let contextCount = 0;
    for (const [index, spec] of specs.entries()) if (index % journalCount === workerIndex) {
      const result = spec.tests[0].results[0]; result.workerIndex = workerIndex; result.parallelIndex = workerIndex;
      const { runtimeFunctionText, ...registration } = registrations.find(r => r.file === 'tests/' + spec.file && r.line === spec.line && r.title === spec.title);
      const contextIdentity = `${processIdentity}/context/${++contextCount}`;
      const attempt = { ...registration, testId: spec.id, retry: 0, workerIndex, parallelIndex: workerIndex, contextIdentity };
      record('attempt-begin-dispatched', { testId: spec.id }); record('context-first-observed', { contextIdentity });
      record('callback-entered', attempt); record('callback-returned', { ...attempt, outcome: 'resolved' });
      record('context-closed', { contextIdentity }); record('attempt-end-dispatched', { testId: spec.id, status: 'passed', duration: result.duration });
    }
    record('worker-exit-hook', { code: 0 });
    const step = (end - start) / BigInt(events.length + 1);
    if (step < 1n) throw new Error('Synthetic owner interval too short');
    for (const [index, event] of events.entries()) event.nanoseconds = String(start + step * BigInt(index + 1));
    return { name: `${process}-${workerIndex}.jsonl`, text: events.map(e => JSON.stringify(e) + '\n').join('') };
  });
  return { schemaVersion: 1, journals };
}
