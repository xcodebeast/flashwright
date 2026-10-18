import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyRemoteConsole } from './verify-remote-console.mjs';

function fixture() {
  const rows = [];
  let clock = 0;
  const append = row => { rows.push({ monotonicNanoseconds: String(++clock), ...row }); };
  const observation = (sessionId, method, parameters, direction = 'receive', id = null) =>
    append({ kind: 'consoleOwnership', sessionId, method, parameters, direction, id });
  for (const [index, path] of ['root', 'child', 'nested', 'replacement', 'successor', 'context-only'].entries()) {
    const remote = !['root', 'replacement'].includes(path), session = remote ? path : 'root';
    if (remote) append({ kind: 'networkOwnership', method: 'Target.attachedToTarget', parameters: { sessionId: session, targetInfo: { type: 'iframe' } } });
    observation(session, 'Page.frameNavigated', { frame: { id: path, url: `http://localhost/${path}` } });
    observation(session, 'Runtime.executionContextCreated', { context: { id: index, uniqueId: path, auxData: { frameId: path, isDefault: true } } });
    observation(session, 'Runtime.consoleAPICalled', { executionContextId: index, arguments: [{ value: 'entry' }, { objectId: path }] });
    for (let use = 0; use < 3; use++) observation(session, 'Runtime.callFunctionOn', { uniqueContextId: path, argumentObjectIds: [path] }, 'send', ++clock);
  }
  for (let index = 0; index < 160; index++) observation('child', 'Runtime.consoleAPICalled', { executionContextId: 1, arguments: [{ value: `burst-${index}` }] });
  observation('context-only', 'Runtime.consoleAPICalled', { executionContextId: 5, arguments: [{ value: 'unobserved-remote' }, { objectId: 'unobserved' }] });
  observation('context-only', 'Runtime.releaseObject', { objectId: 'unobserved', argumentObjectIds: [] }, 'send', 1000);
  append({ kind: 'receive', sessionId: 'context-only', id: 1000, error: false });
  append({ kind: 'send', method: 'Target.disposeBrowserContext', id: 1001 });
  return rows;
}
const command = rows => rows.find(row => row.method === 'Runtime.callFunctionOn' && row.sessionId === 'child');
const releaseReply = rows => rows.find(row => row.kind === 'receive' && row.id === 1000);

test('accepts original live ownership and acknowledged cleanup', () => {
  assert.equal(verifyRemoteConsole(fixture(), 'candidate').unobservedRemoteRelease, true);
});
for (const [name, mutate, error] of [
  ['wrong renderer', rows => { command(rows).sessionId = 'nested'; }, /another original session/],
  ['wrong unique context', rows => { command(rows).parameters.uniqueContextId = 'nested'; }, /wrong unique/],
  ['wrong numeric context', rows => { command(rows).parameters.executionContextId = 2; }, /wrong console execution/],
  ['command after retirement', rows => {
    const row = command(rows);
    rows.push({ kind: 'consoleOwnership', direction: 'receive', method: 'Runtime.executionContextDestroyed', sessionId: 'child',
      monotonicNanoseconds: String(BigInt(row.monotonicNanoseconds) - 1n), parameters: { executionContextId: 1 } });
  }, /retired console argument/],
  ['missing release acknowledgement', rows => { rows.splice(rows.indexOf(releaseReply(rows)), 1); }, /release did not succeed/],
  ['failed release acknowledgement', rows => { releaseReply(rows).error = true; }, /release did not succeed/],
  ['release after context closure', rows => { releaseReply(rows).monotonicNanoseconds = '99999'; }, /release did not succeed/],
  ['release after original context destruction', rows => {
    const reply = releaseReply(rows);
    rows.push({ kind: 'consoleOwnership', direction: 'receive', method: 'Runtime.executionContextDestroyed', sessionId: 'context-only',
      monotonicNanoseconds: reply.monotonicNanoseconds, parameters: { executionContextId: 5 } });
  }, /release did not succeed/],
  ['incorrect individual frame placement', rows => {
    rows.splice(rows.findIndex(row => row.kind === 'networkOwnership' && row.parameters.sessionId === 'nested'), 1);
  }, /individual console frame placement/],
]) test(`rejects ${name}`, () => {
  const rows = fixture(); mutate(rows); assert.throws(() => verifyRemoteConsole(rows, 'candidate'), error);
});
test('does not require reference console history to release unobserved objects early', () => {
  const rows = fixture(); rows.splice(rows.indexOf(releaseReply(rows)), 1);
  assert.equal(verifyRemoteConsole(rows, 'reference').unobservedRemoteRelease, false);
});
