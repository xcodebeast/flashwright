// Fixture app for the runner workloads: a page with a counter, a delayed status and a
// backend save endpoint with a fixed delay.
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const document = `<!doctype html><html><head><title>Flashwright baseline</title>
<style>body { font-family: sans-serif } button,input { margin: 12px; padding: 12px }</style></head>
<body><label>Name <input id="name"></label><button id="increment">Increment</button>
<button id="save">Save</button><div role="status" id="status">Ready</div><span id="count">0</span>
<script>
window.observations = { clicks: [], changes: [], count: 0 };
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
  setTimeout(() => { document.querySelector('#status').textContent = 'Ready'; }, delay);
};
</script></body></html>`;

// A dashboard-like page for the screenshot workloads: text, gradients, borders and shadows
// across the whole viewport, so encoding and comparing costs what a real app page costs.
const visualDocument = `<!doctype html><html><head><title>Flashwright visual</title>
<style>
body { margin: 0; font: 14px/1.4 sans-serif; background: linear-gradient(135deg, #f6f8fb, #e3e9f3); color: #1d2433 }
header { padding: 16px 24px; background: #20304f; color: white; font-size: 20px }
main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 24px }
.card { background: white; border-radius: 10px; padding: 14px; box-shadow: 0 2px 8px rgba(20, 30, 60, .15) }
.card h2 { margin: 0 0 6px; font-size: 15px }
.bar { height: 8px; border-radius: 4px; background: linear-gradient(90deg, #3d7bfd, #9b5cf6) }
</style></head><body><header>Release dashboard</header><main>${Array.from({ length: 16 }, (_, i) => `
<section class="card"><h2>Service ${i + 1}</h2><p>Latency p95 ${(17 + i * 7) % 90} ms, error rate 0.${i}%, ${120 + i * 13} deploys this quarter.</p>
<div class="bar" style="width: ${30 + (i * 17) % 70}%"></div></section>`).join('')}</main></body></html>`;

// A product gallery like most shops have: 24 images from a CDN-like server, and a details
// dialog that fades out and is removed when its transition ends.
const galleryDocument = `<!doctype html><html><head><title>Flashwright gallery</title>
<style>
body { margin: 0; font: 14px/1.4 sans-serif } main { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; padding: 16px }
img { width: 100%; aspect-ratio: 1; display: block; background: #eee }
[role=dialog] { position: fixed; inset: 30% 30%; background: white; padding: 24px; box-shadow: 0 4px 24px rgba(0, 0, 0, .3); transition: opacity 250ms ease-out }
[role=dialog].closing { opacity: 0 }
</style></head><body><button id="details">Details</button><main>${Array.from({ length: 24 }, (_, i) => `<img src="/images/${i}.svg" alt="Product ${i + 1}">`).join('')}</main>
<script>
document.getElementById('details').onclick = () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = '<p>Ships in two days.</p><button>Close</button>';
  dialog.querySelector('button').onclick = () => {
    dialog.addEventListener('transitionend', () => dialog.remove());
    dialog.classList.add('closing');
  };
  document.body.append(dialog);
};
</script></body></html>`;
const imageSource = index => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="hsl(${index * 15}, 60%, 70%)"/><circle cx="100" cy="100" r="${40 + index}" fill="white" opacity=".6"/></svg>`;

export async function startWorkloadServer({ backendDelay = 20, imageDelay = 30 } = {}) {
  const server = createServer(async (request, response) => {
    if (request.url === '/api/profile' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request)
        chunks.push(chunk);
      await setTimeout(backendDelay);
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end(`Saved ${Buffer.concat(chunks).toString('utf8')}`);
    } else if (request.url.startsWith('/visual')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(visualDocument);
    } else if (request.url.startsWith('/embed')) {
      // A page with a cross-site iframe (localhost vs 127.0.0.1), like an embedded widget or payment form.
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><title>Embed</title><h1>Checkout</h1><iframe src="http://localhost:${server.address().port}/widget" width="400" height="200"></iframe>`);
    } else if (request.url.startsWith('/widget')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><button onclick="this.nextElementSibling.textContent = 'Paid'">Pay</button><span>Unpaid</span>`);
    } else if (request.url.startsWith('/gallery')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(galleryDocument);
    } else if (request.url.startsWith('/images/')) {
      await setTimeout(imageDelay);
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      response.end(imageSource(Number(request.url.slice('/images/'.length).split('.')[0])));
    } else if (request.url.startsWith('/fixture')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(document);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  // Both loopback addresses, so that the iframe on `localhost` is reachable however it resolves.
  await new Promise(resolve => server.listen(0, '::', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

// One spec per workload: `count` tests that each open the fixture and do one kind of work.
export function workloadSpec(workload, count) {
  const bodies = {
    noop: `expect(await page.evaluate(() => 42)).toBe(42);`,
    interaction: `await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('#count')).toHaveText('1');`,
    assertion: `await page.evaluate(() => window.delayStatus(8));
    await expect(page.getByRole('status')).toHaveText('Ready');`,
    navigation: `const response = await page.goto('/fixture?navigation=' + index);
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle('Flashwright baseline');
    await expect(page.getByRole('status')).toHaveText('Ready');`,
    setup: `await expect(page.getByRole('status')).toHaveText('Ready');`,
    backend: `const name = 'person-' + index;
    await page.getByLabel('Name').fill(name);
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/profile')),
      page.getByRole('button', { name: 'Save' }).click(),
    ]);
    expect(response.status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('Saved ' + name);`,
    failure: `await expect(page.locator('#missing')).toBeVisible({ timeout: 250 });`,
    // A suite with real failures: every third test fails, and each failure replaces the worker.
    broken: `await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('#count')).toHaveText(index % 3 ? '1' : '2', { timeout: 250 });`,
    // Visual regression against a committed baseline.
    screenshot: `await expect(page).toHaveScreenshot('visual.png');`,
    // An agent looking at its work: one viewport capture written to disk.
    capture: `await page.screenshot({ path: test.info().outputPath('capture.png') });`,
    // Product details opened and closed on a page full of images.
    media: `await page.getByRole('button', { name: 'Details' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();`,
    // A click inside a cross-site iframe.
    iframe: `const widget = page.frameLocator('iframe');
    await widget.getByRole('button', { name: 'Pay' }).click();
    await expect(widget.locator('span')).toHaveText('Paid');`,
  };
  const visual = workload === 'screenshot' || workload === 'capture';
  const start = visual ? '/visual' : workload === 'iframe' ? '/embed' : workload === 'media' ? '/gallery' : '/fixture';
  return `import { test, expect } from '../adapter.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('${start}');
});

for (let index = 0; index < ${count}; index++) {
  test('${workload} ' + index, async ({ page }) => {
    ${workload === 'failure' ? 'test.fail();\n    ' : ''}${bodies[workload]}
  });
}
`;
}
