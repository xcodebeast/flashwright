import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { convertNetworkTraceEntry, networkTraceEntryLimits } = require('../packages/flashwright-core/dist/commonjs/trace-network-entry.js');
const typescript = require('typescript');
const output = resolve(process.argv[2]);
await mkdir(output);
const report = { status: 'running', checks: [] };
const alias = 'a'.repeat(64) + '.dat';
const originalWallTime = 1700000000000;
const clone = value => JSON.parse(JSON.stringify(value));
const context = { pageReference: 'trace-page', monotonicTime: 123, cookieWallTime: originalWallTime, resolveResource: () => ({ alias, byteLength: 4 }) };
const pending = { kind: 'pending' };
const captured = { kind: 'resource', token: 'body', byteLength: 4 };
const unavailable = { kind: 'unavailable', reason: 'redirect' };
const fixture = () => ({
  page: 'native-page', frame: 'frame-original', identity: { sequence: 10 }, nativeTime: 800, startedWallTime: originalWallTime,
  originalIngress: { sequence: 10, nativeTime: 799 }, originalRequestTimestamp: 100, originalRequestWallTime: 1600000000,
  request: { url: 'http://example.test/a?q=1&q=2', method: 'GET', resourceType: 'stylesheet', headers: [{ name: 'Cookie', value: 'a=1; b=2' }] },
  effectiveRequest: { url: 'http://example.test/a?q=1&q=2', method: 'GET' },
  requestHeadersReady: true, responseHeadersReady: true, servedFromCache: false, routing: {},
  response: { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/css; charset=utf-8', 'Content-Length': '4' }, protocol: 'h2',
    remoteIPAddress: '127.0.0.1', remotePort: 8080,
    timing: { dnsStart: 0.1, dnsEnd: 0.3, connectStart: 0.4, connectEnd: 0.9, sslStart: -1, sendStart: 1, receiveHeadersEnd: 2.5 } },
  responseExtra: { headersText: 'HTTP/1.1 200 OK\r\n\r\n', statusCode: 304 },
  terminal: { kind: 'finished', timestamp: 100.005, encodedDataLength: 23 },
});
async function check(name, callback) { await callback(); report.checks.push(name); }
const convert = (metadata = fixture(), body = captured, mapping = context) => clone(convertNetworkTraceEntry(metadata, body, mapping));

try {
  await check('original identity and admission clocks survive routing and delayed export', () => {
    const metadata = fixture();
    metadata.effectiveRequest = { url: 'https://elsewhere.test/longer?ignored=12345', method: 'POST' };
    metadata.requestHeaders = [{ name: 'X-Effective', value: 'yes' }];
    metadata.routing = { continued: true, fulfilled: true, aborted: false };
    const entry = convert(metadata);
    assert.equal(entry.pageref, 'trace-page'); assert.equal(entry._frameref, 'frame-original');
    assert.equal(entry.startedDateTime, new Date(originalWallTime).toISOString()); assert.equal(entry._monotonicTime, 123);
    assert.equal(entry.request.url, metadata.request.url); assert.equal(entry.request.method, 'GET');
    assert.deepEqual(entry.request.queryString, [{ name: 'q', value: '1' }, { name: 'q', value: '2' }]);
    assert.deepEqual(entry.request.headers, metadata.requestHeaders);
    assert.equal(entry.request.headersSize, 4 + 4 + 7 + 8 + 11 + 3 + 4);
    assert.equal(entry._wasContinued, true); assert.equal(entry._wasFulfilled, true); assert.equal(entry._wasAborted, undefined);
  });
  await check('captured bytes, unavailable bytes, empty bytes and pending bytes remain distinct', () => {
    const entry = convert();
    assert.equal(entry.response.status, 200); assert.equal(entry.response.httpVersion, 'HTTP/2.0');
    assert.equal(entry.response.content.mimeType, 'text/css; charset=utf-8');
    assert.equal(entry.response.content.size, 4); assert.equal(entry.response.content._sha1, alias);
    assert.deepEqual(entry._securityDetails, {});
    const missing = convert(fixture(), unavailable); assert.equal(missing.response.content.size, -1); assert.equal(missing.response.content._sha1, undefined); assert.equal(missing.response.content.compression, 0);
    const waiting = convert(fixture(), pending); assert.equal(waiting.response.content.size, -1); assert.equal(waiting.response.content.compression, undefined);
    const empty = convert(fixture(), { kind: 'resource', token: 'empty', byteLength: 0 }, { ...context, resolveResource: () => ({ alias, byteLength: 0 }) });
    assert.equal(empty.response.content.size, 0); assert.equal(empty.response.content._sha1, alias);
    assert.throws(() => convert(fixture(), captured, { ...context, resolveResource: () => ({ alias, byteLength: 3 }) }), /length mismatch/);
    assert.throws(() => convert(fixture(), captured, { ...context, resolveResource: () => ({ alias: '../private', byteLength: 4 }) }), /resource alias/);
  });
  await check('raw extra presence, cache fallback and unsettled headers control sizes independently', () => {
    const metadata = fixture(); const measured = convert(metadata);
    assert.equal(measured.response.headersSize, metadata.responseExtra.headersText.length);
    assert.equal(measured.response.bodySize, 4); assert.equal(measured.response._transferSize, 23);
    metadata.responseExtra = {}; assert.equal(convert(metadata).response.headersSize, 0);
    delete metadata.responseExtra;
    const estimated = convert(metadata).response.headersSize;
    assert.equal(estimated, 4 + 8 + 3 + 2 + 2 + Object.entries(metadata.response.headers).reduce((sum, [name, value]) => sum + name.length + value.length + 4, 0));
    metadata.responseExtra = { headersText: 'ignored' }; metadata.servedFromCache = true;
    assert.equal(convert(metadata).response.headersSize, estimated);
    metadata.responseHeadersReady = false; const pendingHeaders = convert(metadata);
    for (const field of ['headersSize', 'bodySize', '_transferSize']) assert.equal(pendingHeaders.response[field], -1);
    assert.equal(pendingHeaders.request.headersSize, -1);
    metadata.responseHeadersReady = true; metadata.requestHeadersReady = false; assert.equal(convert(metadata).response.headersSize, -1);
  });
  await check('pinned timing truncation, plain HTTP ssl quirk, end clamp and cache timing survive', () => {
    const metadata = fixture(); const entry = convert(metadata);
    assert.equal(entry.timings.ssl, 1.9); assert.equal(entry.timings.send, 0); assert.equal(entry.timings.wait, 1.5);
    assert.equal(entry.timings.receive, 2.498); // CDP seconds truncation precedes millisecond truncation.
    assert.equal(entry.time, ['dns', 'connect', 'ssl', 'wait', 'receive'].reduce((sum, name) => sum + Math.max(0, entry.timings[name]), 0));
    metadata.terminal.timestamp = 100.001; assert.equal(convert(metadata).timings.receive, 0);
    metadata.servedFromCache = true; const cached = convert(metadata);
    assert.deepEqual(cached.cache, {}); assert.equal(cached.timings.dns, -1); assert.equal(cached.timings.ssl, -1);
    assert.equal(cached.timings.receive, 2);
    metadata.servedFromCache = false; metadata.terminal.timestamp = 100 + 3000;
    assert.equal(convert(metadata).timings.receive, 0); // Pinned int32 conversion overflows before end clamp.
  });
  await check('redirect fallback uses canonical successor and failed requests keep unfinished fields', () => {
    const metadata = fixture(); metadata.response.status = 302; metadata.redirectURL = 'https://successor.test/final'; delete metadata.terminal.encodedDataLength;
    const redirected = convert(metadata, unavailable);
    assert.equal(redirected.response.redirectURL, metadata.redirectURL); assert.equal(redirected.response.bodySize, 4);
    assert.equal(redirected.response._transferSize, redirected.response.headersSize + 4);
    assert.throws(() => convert(metadata), /non-redirect/);
    metadata.terminal = { kind: 'failed', timestamp: 100.005, errorText: 'net::ERR_FAILED' }; metadata.response.status = 200;
    const failed = convert(metadata, unavailable);
    assert.equal(failed.response._failureText, 'net::ERR_FAILED'); assert.equal(failed.response.headersSize, -1);
    assert.equal(failed.response.httpVersion, 'HTTP/1.1'); assert.equal(failed.timings.receive, -1); assert.equal(failed._securityDetails, undefined);
    delete metadata.response; const noResponse = convert(metadata, unavailable);
    assert.equal(noResponse.response.status, -1); assert.equal(noResponse.time, -1); assert.deepEqual(noResponse.timings, { send: -1, wait: -1, receive: -1 });
  });
  await check('request resources preserve original MIME, binary alias and exact form MIME semantics', () => {
    const metadata = fixture(); metadata.requestPostData = { token: 'post', byteLength: 4, mimeType: 'application/x-www-form-urlencoded' };
    const mapping = { ...context, resolveResource: () => ({ alias, byteLength: 4, formParameters: [{ name: 'repeat', value: '1' }, { name: 'repeat', value: '2' }] }) };
    const entry = convert(metadata, captured, mapping);
    assert.equal(entry.request.bodySize, 4); assert.equal(entry.request.postData.text, '');
    assert.deepEqual(entry.request.postData.params, mapping.resolveResource().formParameters);
    metadata.requestPostData.mimeType += '; charset=utf-8'; assert.deepEqual(convert(metadata, captured, mapping).request.postData.params, []);
    metadata.requestPostData.mimeType = 'application/octet-stream'; assert.equal(convert(metadata).request.postData._sha1, alias);
  });
  await check('cookies use actual selected headers and retained parse clock with pinned attribute casing', () => {
    const metadata = fixture(); metadata.requestExtra = { associatedCookies: [{ cookie: { name: 'blocked', value: 'never' } }] };
    metadata.responseHeaders = [{ name: 'Set-Cookie', value: 'id=a=b; Max-Age=10; Path=/; Secure; HttpOnly; SameSite=Lax; domain=ignored' }];
    const entry = convert(metadata);
    assert.deepEqual(entry.request.cookies, [{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
    assert.equal(entry.response.content.mimeType, 'text/css; charset=utf-8');
    assert.deepEqual(entry.response.cookies, [{ name: 'id', value: 'a=b', expires: new Date(originalWallTime + 10000).toISOString(), path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  });
  await check('bounded JSON rejects accessors, cycles, deep input, long strings and excessive headers', () => {
    let reads = 0; const accessor = fixture(); Object.defineProperty(accessor, 'request', { enumerable: true, get() { reads++; return {}; } });
    assert.throws(() => convert(accessor), /own data/); assert.equal(reads, 0);
    const cyclic = fixture(); cyclic.extra = cyclic; assert.throws(() => convert(cyclic), /cycle/);
    const deep = fixture(); let value = deep; for (let index = 0; index < 20; index++) value = value.extra = {}; assert.throws(() => convert(deep), /depth/);
    const long = fixture(); long.extra = 'x'.repeat(networkTraceEntryLimits.stringUnits + 1); assert.throws(() => convert(long), /string limit/);
    const manyHeaders = fixture(); manyHeaders.request.headers = Array.from({ length: networkTraceEntryLimits.headers + 1 }, () => ({ name: 'a', value: 'b' })); assert.throws(() => convert(manyHeaders), /header limit/);
    const tooManyBytes = fixture(); tooManyBytes.extra = Array.from({ length: 5 }, () => 'x'.repeat(networkTraceEntryLimits.stringUnits)); assert.throws(() => convert(tooManyBytes), /byte limit/);
    const sparse = fixture(); sparse.extra = new Array(1); assert.throws(() => convert(sparse), /dense/);
    const nonFinite = fixture(); nonFinite.startedWallTime = NaN; assert.throws(() => convert(nonFinite), /finite/);
    const metadata = fixture(); const before = clone(metadata); const entry = convert(metadata); entry.request.headers[0].value = 'changed'; assert.deepEqual(metadata, before);
  });
  await check('controlled entries match extracted pinned HAR methods, including unavailable response content', async () => {
    const source = await readFile(join(require.resolve('playwright-core/package.json'), '..', 'lib', 'coreBundle.js'), 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    assert.equal(hash, 'f74353fcb8e406756a70a6af0dfc4a5069acd577e35ec9d923ccf36ac009c2f5');
    const syntax = typescript.createSourceFile('coreBundle.js', source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
    const methods = new Map(); const functions = new Map();
    function visit(node) {
      if (typescript.isFunctionDeclaration(node) && ['createHarEntry', 'parseCookie', 'safeDateToISOString'].includes(node.name?.text)) functions.set(node.name.text, node.getText(syntax));
      if (typescript.isBinaryExpression(node) && node.left.getText(syntax) === 'HarTracer' && typescript.isClassExpression(node.right)) for (const member of node.right.members) if (typescript.isMethodDeclaration(member)) methods.set(member.name.getText(syntax), member.getText(syntax));
      typescript.forEachChild(node, visit);
    }
    visit(syntax);
    const names = ['_recordRequestHeadersAndCookies', '_recordResponseHeaders', '_computeHarEntryTotalTime', '_onResponse', '_onRequestFinished', '_storeResponseContent', '_postDataForBuffer'];
    class ManualPromise { constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); } then(...arguments_) { return this.promise.then(...arguments_); } }
    const sandbox = { Buffer, URL, URLSearchParams, Date, ManualPromise, FALLBACK_HTTP_VERSION: 'HTTP/1.1', monotonicTime: () => 123, nullProgress: {}, mime6: { getExtension: () => 'dat' }, calculateSha1: bytes => createHash('sha1').update(bytes).digest('hex'), helper: { millisToRoundishMillis: value => (value * 1000 | 0) / 1000 } };
    const pinned = vm.runInNewContext(`${[...functions.values()].join('\n')}\n({ createHarEntry, prototype: {${names.map(name => methods.get(name)).join(',\n')}} })`, sandbox);
    for (const state of ['resource', 'unavailable']) {
      const metadata = fixture(); const decoded = Buffer.from([0, 255, 128, 0]);
      const reference = pinned.createHarEntry('trace-page', metadata.request.method, new URL(metadata.request.url), metadata.frame, { includeTraceInfo: true });
      reference.startedDateTime = new Date(originalWallTime).toISOString(); reference.request.bodySize = 0;
      const barriers = [];
      const tracer = { ...pinned.prototype, _options: { content: 'attach', includeTraceInfo: true }, _started: true,
        _entryForRequest: () => reference, _createPageEntryIfNeeded: () => undefined, _recordRequestOverrides() {},
        _addBarrier: (_, promise) => barriers.push(promise), _delegate: { onEntryFinished() {}, onContentBlob() {} } };
      const request = { frame: () => undefined, serviceWorker: () => undefined, resourceType: () => 'stylesheet', rawRequestHeaders: async () => metadata.request.headers, _responseEndTiming: 4.999 };
      const response = { request: () => request, frame: () => undefined, status: () => 200, statusText: () => 'OK', headers: () => Object.entries(metadata.response.headers).map(([name, value]) => ({ name, value })), rawResponseHeaders: async () => response.headers(),
        timing: () => ({ domainLookupStart: 0.1, domainLookupEnd: 0.3, connectStart: 0.4, connectEnd: 0.9, secureConnectionStart: -1, requestStart: 1, responseStart: 2.5 }),
        serverAddr: async () => ({ ipAddress: '127.0.0.1', port: 8080 }), securityDetails: async () => ({}), httpVersion: async () => 'HTTP/2.0',
        sizes: async () => ({ requestHeadersSize: 4 + 3 + 2 + 8 + 6 + 8 + 4, responseHeadersSize: 19, responseBodySize: 4, transferSize: 23 }),
        internalBody: async () => { if (state === 'unavailable') throw new Error('unavailable'); return decoded; } };
      tracer._recordRequestHeadersAndCookies(reference, metadata.request.headers); tracer._onResponse(response); await tracer._onRequestFinished(request, response); await Promise.all(barriers);
      const actual = convert(metadata, state === 'resource' ? captured : unavailable, { ...context, resolveResource: () => ({ alias: createHash('sha1').update(decoded).digest('hex') + '.dat', byteLength: 4 }) });
      assert.deepEqual(actual, clone(reference));
    }
    report.pinnedSourceSha256 = hash;
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(join(output, 'report.json')); }
