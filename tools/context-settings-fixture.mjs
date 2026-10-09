import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpFixture, ownFixtureServer } from './http-fixture.mjs';

/** Create a self-signed local server without trusting its certificate on the host. */
export async function startContextSettingsFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'flashwright-context-settings-'));
  let plain, secure;
  const requests = [];
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'certificate.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    let secureOrigin;
    const listener = (request, response) => {
      const url = new URL(request.url, 'http://fixture');
      requests.push({ secure: Boolean(request.socket.encrypted), path: url.pathname });
      response.setHeader('cache-control', 'no-store');
      if (url.pathname === '/external.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end('globalThis.externalRuns=(globalThis.externalRuns??0)+1;');
        return;
      }
      if (url.pathname === '/secure-data') {
        response.setHeader('content-type', 'application/json'); response.end('{"secure":true}'); return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><title>Context settings</title><link rel="icon" href="data:,">
        <div id="ready">Ready</div><noscript><div id="no-script">JavaScript disabled</div></noscript>
        <button id="action" onclick="globalThis.clicks=(globalThis.clicks??0)+1">Action</button>
        <script>globalThis.inlineRuns=(globalThis.inlineRuns??0)+1;</script>
        <script src="${url.pathname === '/secure-subresource' ? secureOrigin : ''}/external.js"></script>
        ${url.pathname === '/parent' ? '<iframe name="child" src="/child"></iframe>' : ''}`);
    };
    plain = createHttpFixture(listener);
    secure = ownFixtureServer(createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'certificate.pem')) }, listener));
    for (const fixture of [plain, secure]) { fixture.server.listen(0, '127.0.0.1'); await once(fixture.server, 'listening'); }
    secureOrigin = `https://127.0.0.1:${secure.server.address().port}`;
    return {
      origin: `http://127.0.0.1:${plain.server.address().port}`, secureOrigin, requests,
      async close() {
        try { await Promise.all([plain.close(), secure.close()]); }
        finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await Promise.allSettled([plain?.close(), secure?.close()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
