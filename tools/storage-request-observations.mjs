import assert from 'node:assert/strict';

/** Keep the candidate's zero-network contract separate from the pinned fallback-page race. */
export function classifyPrivateStorageRequests(engine, requests, origins, snapshots = 1) {
  assert.ok(engine === 'reference' || engine === 'flashwright', 'Unknown storage engine');
  assert.ok(Number.isSafeInteger(snapshots) && snapshots > 0, 'Invalid private navigation bound');
  if (engine === 'flashwright') {
    assert.deepEqual(requests, [], `Private storage must not reach the application server: ${JSON.stringify(requests)}`);
    return [];
  }
  const counts = new Map();
  for (const request of requests) {
    assert.ok(request.child === undefined || request.child === true, 'Unknown serving origin');
    const origin = request.child === true ? origins.child : origins.main;
    assert.ok(request.method === 'GET' && request.path === '/favicon.ico' && request.referer === origin + '/',
      `Unexpected reference storage request: ${JSON.stringify(request)}`);
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
    assert.ok(counts.get(origin) <= snapshots, 'More reference favicon requests than private origin navigations');
  }
  return requests.map(request => ({ ...request, classification: 'reference-private-document-favicon' }));
}

/** Include teardown and the intervals between individual storage calls. */
export function auditStorageRequests(engine, requests, origins, publicRequests, privateNavigations) {
  const icons = requests.filter(request => request.path === '/favicon.ico');
  const publicKeys = requests.filter(request => request.path !== '/favicon.ico')
    .map(request => `${request.child === true ? 'child' : 'main'} ${request.method} ${request.path}`).sort();
  assert.deepEqual(publicKeys, [...publicRequests].sort(), 'Unexpected application-server traffic across the complete browser lifetime');
  return [false, true].flatMap(child => classifyPrivateStorageRequests(engine,
    icons.filter(request => (request.child === true) === child), origins,
    privateNavigations[child ? 'child' : 'main']));
}
