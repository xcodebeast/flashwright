import assert from 'node:assert/strict';

const key = (session, identifier) => JSON.stringify([session, identifier]);

/** Validate the observed original ownership; the relay is not a timing benchmark. */
export function verifyRemoteConsole(rows, engine) {
  const remote = new Set(rows.filter(row => row.kind === 'networkOwnership' && row.method === 'Target.attachedToTarget'
    && row.parameters.targetInfo.type === 'iframe').map(row => row.parameters.sessionId));
  const observations = rows.filter(row => row.kind === 'consoleOwnership');
  const knownObjects = new Set(observations.filter(row => row.method === 'Runtime.consoleAPICalled')
    .flatMap(row => row.parameters.arguments.map(argument => argument.objectId).filter(Boolean)));
  const contexts = new Map(), owners = new Map(), frameUrls = new Map();
  const events = [], uses = [], releases = [], entries = [];
  const teardown = rows.find(row => row.kind === 'send' && row.method === 'Target.disposeBrowserContext');
  assert(teardown, 'missing context teardown');
  const teardownTime = BigInt(teardown.monotonicNanoseconds);
  const retire = (predicate, timestamp) => {
    for (const context of contexts.values()) if (context.alive && predicate(context)) {
      context.alive = false; context.retiredAt = timestamp;
    }
  };
  // The two relay directions run on separate threads. Sort by their captured
  // monotonic times; stable ties retain the byte order within each pipe chunk.
  observations.sort((a, b) => BigInt(a.monotonicNanoseconds) < BigInt(b.monotonicNanoseconds) ? -1
    : BigInt(a.monotonicNanoseconds) > BigInt(b.monotonicNanoseconds) ? 1 : 0);
  for (const row of observations) {
    const { method, sessionId: session, parameters: parameters } = row;
    const timestamp = BigInt(row.monotonicNanoseconds);
    if (method === 'Page.frameNavigated') frameUrls.set(parameters.frame.id, parameters.frame.url);
    if (method === 'Runtime.executionContextCreated') {
      const context = parameters.context, identifier = key(session, context.id);
      assert(!contexts.get(identifier)?.alive, 'live execution context identifier was reused');
      contexts.set(identifier, { ...context, session, alive: true });
    }
    if (method === 'Runtime.executionContextDestroyed') retire(context => context.session === session
      && context.id === parameters.executionContextId, timestamp);
    if (method === 'Runtime.executionContextsCleared') retire(context => context.session === session, timestamp);
    if (method === 'Target.detachedFromTarget') retire(context => context.session === parameters.sessionId, timestamp);
    if (method === 'Runtime.consoleAPICalled') {
      const context = contexts.get(key(session, parameters.executionContextId));
      assert(context?.alive && context.uniqueId, 'console event has no live original execution context');
      assert(context.auxData?.isDefault, 'fixture console escaped its main world');
      const event = { row, context };
      events.push(event);
      if (parameters.arguments[0]?.value === 'entry') {
        const url = frameUrls.get(context.auxData.frameId);
        assert(url, 'console frame has no observed navigation');
        entries.push({ path: new URL(url).pathname, remote: remote.has(session), session, context: context.uniqueId });
      }
      for (const argument of parameters.arguments) if (argument.objectId) {
        const identifier = key(session, argument.objectId), previous = owners.get(identifier);
        assert(!previous || previous === context, 'ambiguous console object identifier across context lifetimes');
        owners.set(identifier, context);
      }
    }
    if (row.direction !== 'send' || !['Runtime.callFunctionOn', 'Runtime.releaseObject'].includes(method)) continue;
    for (const objectId of [parameters.objectId, ...parameters.argumentObjectIds].filter(Boolean)) {
      if (!knownObjects.has(objectId)) continue;
      const context = owners.get(key(session, objectId));
      assert(context, 'console argument command addressed another original session or preceded its event');
      if (parameters.uniqueContextId !== undefined) assert.equal(parameters.uniqueContextId, context.uniqueId, 'wrong unique console context');
      if (parameters.executionContextId !== undefined) assert.equal(parameters.executionContextId, context.id, 'wrong console execution context');
      if (method === 'Runtime.callFunctionOn') {
        if (engine === 'candidate') assert(context.alive && timestamp < teardownTime, 'retired console argument dispatched to browser');
        uses.push({ session, context, objectId });
      } else releases.push({ row, context, objectId });
    }
  }
  const expectedPlacement = [
    ['/root', false], ['/child', true], ['/nested', true], ['/replacement', false], ['/successor', true], ['/context-only', true],
  ];
  assert.deepEqual(entries.map(entry => [entry.path, entry.remote]).sort(), expectedPlacement.sort(), 'individual console frame placement');
  const root = entries.find(entry => entry.path === '/root');
  assert.equal(entries.find(entry => entry.path === '/replacement').session, root.session);
  const unobserved = events.filter(event => event.row.parameters.arguments[0]?.value === 'unobserved-remote');
  assert.equal(unobserved.length, 1);
  const event = unobserved[0];
  assert(remote.has(event.row.sessionId));
  const objects = event.row.parameters.arguments.filter(argument => argument.objectId);
  assert(objects.length > 0);
  const unobservedReleased = objects.every(argument => releases.some(release => {
    if (release.objectId !== argument.objectId || release.context !== event.context) return false;
    const reply = rows.find(row => row.kind === 'receive' && row.id === release.row.id && row.sessionId === release.row.sessionId);
    if (!reply || reply.error !== false) return false;
    const completed = BigInt(reply.monotonicNanoseconds);
    return completed >= BigInt(release.row.monotonicNanoseconds) && completed < teardownTime
      && (release.context.retiredAt === undefined || completed < release.context.retiredAt);
  }));
  if (engine === 'candidate') assert(unobservedReleased, 'unobserved remote object release did not succeed before original context retirement');
  const remoteUses = uses.filter(use => remote.has(use.session));
  assert(remote.size >= 3); assert(remoteUses.length >= 8);
  const bursts = events.filter(event => event.row.parameters.arguments[0]?.value?.startsWith?.('burst-'));
  assert.equal(bursts.length, 160);
  assert(bursts.every(event => remote.has(event.row.sessionId)), 'burst was not in a remote renderer');
  return {
    remoteSessions: remote.size, remoteConsoleEvents: events.filter(event => remote.has(event.row.sessionId)).length,
    remoteArgumentUses: remoteUses.length, remoteBurstEvents: bursts.length, unobservedRemoteRelease: unobservedReleased,
    placement: entries.map(({ path, remote }) => ({ path, remote })),
  };
}
