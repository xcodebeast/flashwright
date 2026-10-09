import assert from 'node:assert/strict';
import { BrowserContext, Page } from '../packages/flashwright-core/dist/commonjs/index.js';

const subscribers = new Map();
const failures = [];
const client = {
  subscribeObject(identifier, callback) { subscribers.set(identifier, callback); return () => subscribers.delete(identifier); },
  rejectProtocol(error) { failures.push(error); },
};
const context = new BrowserContext(client, 'context', null, null, undefined);
const page = new Page(client, 'page', context, false, { identifier: 'page', frames: [], mainFrame: 'frame', navigationSequence: 0 });
const requests = [], responses = [], finished = [], failed = [];
page.on('request', request => requests.push(request));
page.on('response', response => responses.push(response));
page.on('requestfinished', request => finished.push(request));
page.on('requestfailed', request => failed.push(request));
const emit = (event, parameters) => subscribers.get('page')({ event, parameters });
const metadata = identity => ({ identifier: 'reused', identity, url: 'https://example.test/body', method: 'POST', headers: {}, postDataEntries: ['AP+A'], resourceType: 'Fetch', navigation: false, frame: 'frame', loader: '' });
const reference = identity => ({ identifier: 'reused', identity });
const response = identity => ({ identifier: 'reused', request: reference(identity), url: 'https://example.test/body', status: 200, statusText: 'OK', headers: {}, fromServiceWorker: false });

emit('request', metadata('first'));
emit('response', response('first'));
emit('requestfinished', reference('first'));
assert.equal(responses[0].request(), requests[0]);
assert.equal(finished[0], requests[0]);
assert.equal(await requests[0].response(), responses[0]);
assert.deepEqual(requests[0].postDataBuffer(), Buffer.from([0, 255, 128]));
emit('request', metadata('second'));
emit('requestfailed', { request: reference('second'), errorText: 'net::ERR_FAILED' });
assert.notEqual(requests[1], requests[0]);
assert.equal(failed[0], requests[1]);
assert.equal(await requests[1].response(), null);
assert.deepEqual(requests[1].failure(), { errorText: 'net::ERR_FAILED' });
assert.equal(failures.length, 0);

emit('response', response('unknown'));
emit('requestfinished', { identifier: 'unrelated', identity: 'first' });
emit('requestfailed', { request: reference('unknown'), errorText: 'wrong owner' });
emit('response', { ...response('first'), identifier: 'unrelated' });
emit('response', { ...response('first'), request: { identifier: 'unrelated', identity: 'first' } });
assert.equal(failures.length, 5);
assert(failures.every(error => error.name === 'ProtocolError'));
assert.equal(requests.length, 2);
assert.equal(responses.length, 1);
assert.equal(finished.length, 1);
assert.equal(failed.length, 1);
const childSnapshot = { identifier: 'child', parent: 'frame', name: '', url: 'https://example.test/child', navigationSequence: 0, loader: 'child-loader' };
emit('frameattached', childSnapshot);
emit('request', { ...metadata('child-request'), frame: 'child' });
const childRequest = requests.at(-1), originalFrame = childRequest.frame();
emit('framedetached', childSnapshot);
assert.equal(originalFrame.isDetached(), true);
assert.equal(childRequest.frame(), originalFrame, 'detached request retains its original frame');
emit('frameattached', { ...childSnapshot, loader: 'replacement-loader' });
assert.notEqual(page.frameByIdentifier('child'), originalFrame);
assert.equal(childRequest.frame(), originalFrame, 'a reused frame identifier cannot replace the original owner');
page.didClose();
assert.equal(childRequest.frame(), originalFrame);
context.didClose();
console.log('Network references preserve occurrence and original frame identity, including detach/reuse/close, and reject missing or mismatched owners.');
