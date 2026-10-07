import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const document = `<!doctype html><html><head><title>Flashwright baseline</title>
<style>body { font-family: sans-serif } button,input { margin: 12px; padding: 12px }</style></head>
<body><label>Name <input id="name"></label><button id="increment">Increment</button>
<button id="save">Save</button><div role="status" id="status">Ready</div><span id="count">0</span>
<script>
window.observations = { clicks: [], changes: [], count: 0, readyAt: 0 };
document.querySelector('#increment').onclick = event => {
  window.observations.clicks.push(event.isTrusted);
  document.querySelector('#count').textContent = String(++window.observations.count);
};
document.querySelector('#name').oninput = event => window.observations.changes.push(event.isTrusted);
document.querySelector('#save').onclick = async event => {
  window.observations.clicks.push(event.isTrusted);
  const response = await fetch('/api/profile', { method: 'POST', body: document.querySelector('#name').value });
  document.querySelector('#status').textContent = await response.text();
};
window.delayStatus = delay => {
  document.querySelector('#status').textContent = 'Waiting';
  setTimeout(() => { document.querySelector('#status').textContent = 'Ready'; window.observations.readyAt = performance.now(); }, delay);
};
</script></body></html>`;

/** Use real HTTP work, retaining request counts independently of browser instrumentation. */
export async function startFixtureServer(backendDelayMilliseconds) {
  const counts = { documents: 0, backendRequests: 0, otherRequests: 0 };
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/profile' && request.method === 'POST') {
        counts.backendRequests++;
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const name = Buffer.concat(chunks).toString('utf8');
        await setTimeout(backendDelayMilliseconds);
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        response.end(`Saved ${name}`);
      } else if (request.url.startsWith('/fixture')) {
        counts.documents++;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(document);
      } else {
        counts.otherRequests++;
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, counts,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
