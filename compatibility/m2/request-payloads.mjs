import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const counts = new Map();
const sockets = new Set();
const server = createServer(async (request, response) => {
  counts.set(request.url, (counts.get(request.url) ?? 0) + 1);
  if (!request.url.startsWith('/body?')) { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html>body fixture'); return; }
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of request) { hash.update(chunk); bytes += chunk.length; }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ bytes, sha256: hash.digest('hex') }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const outcomes = {};

async function run(consumer, chromium) {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath() });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(30000); await page.goto(origin);
    const results = [];
    for (const kind of ['ascii', 'all', 'zero']) {
      const size = 4 * 1024 * 1024;
      const expected = Buffer.alloc(size, kind === 'ascii' ? 97 : 0);
      if (kind === 'all') for (let index = 0; index < size; index++) expected[index] = index % 256;
      const sha256 = createHash('sha256').update(expected).digest('hex');
      const path = `/body?consumer=${consumer}&kind=${kind}`;
      const requestEvent = page.waitForEvent('request', { predicate: request => request.url() === origin + path });
      const responseEvent = page.waitForResponse(origin + path);
      const finishedEvent = page.waitForEvent('requestfinished', { predicate: request => request.url() === origin + path });
      const received = await page.evaluate(async ({ path, kind, size }) => {
        const body = new Uint8Array(size);
        if (kind === 'ascii') body.fill(97);
        if (kind === 'all') for (let index = 0; index < size; index++) body[index] = index % 256;
        return (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body })).json();
      }, { path, kind, size });
      const request = await requestEvent;
      const response = await responseEvent;
      assert.deepEqual(received, { bytes: size, sha256 });
      assert.deepEqual(request.postDataBuffer(), expected);
      assert.equal(request.postData(), expected.toString('utf8'));
      assert.equal(response.request(), request);
      assert.equal(await finishedEvent, request);
      assert.equal(await request.response(), response);
      assert.equal(await request.headerValue('content-type'), 'application/octet-stream');
      assert.deepEqual(await response.json(), received);
      assert.equal(counts.get(path), 1);
      results.push({ kind, bytes: size, sha256, requests: 1 });
    }
    assert.equal(await page.evaluate(() => 42), 42);
    await page.close();
    return results;
  } finally { await browser.close(); }
}

try {
  outcomes.reference = await run('reference', referenceChromium);
  outcomes.flashwright = await run('flashwright', flashwrightChromium);
  assert.deepEqual(outcomes.flashwright, outcomes.reference);
  const destination = `compatibility/evidence/request-payloads-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}.json`;
  await mkdir('compatibility/evidence', { recursive: true });
  await writeFile(destination, JSON.stringify({ fixture: 'compatibility/m2/request-payloads.mjs', fixtureSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), reference: '1.60.0', ...runtimeMetadata, platform: process.platform, architecture: process.arch, outcomes }, null, 2) + '\n');
  console.log('Request payload differential passed: ' + destination);
} finally { for (const socket of sockets) socket.destroy(); server.close(); }
