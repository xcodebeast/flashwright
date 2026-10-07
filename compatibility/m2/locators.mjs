import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';

const fixture = `<!doctype html><meta charset="utf-8"><title>Locators</title>
<h1>  Café  😃 <span>hello</span></h1><p>Another hello</p>
<button aria-label="Publish document">hidden accessible text</button>
<button aria-describedby="description">Send</button><span id="description">To your team</span>
<button hidden>Hidden button</button><div role="checkbox" aria-checked="true">ARIA choice</div>
<label for="email"> E-mail <span>address</span></label><input id="email" placeholder="Your e-mail" value="before">
<input id="readonly" readonly value="unchanged"><input type="checkbox" checked><fieldset disabled><input id="disabled"></fieldset>
<label>Date <input id="date" type="date"></label><textarea id="area"></textarea>
<div contenteditable id="editor">before</div>
<select id="select" multiple><option value="red">Red</option><option value="blue">Blue sky</option><option value="green" disabled>Green</option></select>
<section data-testid="list"><article><h2>Alpha</h2><p>A</p></article><article><h2>Beta</h2><p>B</p></article></section>
<img alt="A sunrise" title="Dawn"><div id="host"></div><div id="closed"></div>
<div id="pending" hidden>pending</div><div id="replacement">original</div>
<iframe name="child" src="/child"></iframe>
<script>
document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button data-testid="shadow">Shadow action</button><slot></slot>';
document.querySelector('#closed').attachShadow({mode:'closed'}).innerHTML='<button>Closed action</button>';
window.records=[]; for(const type of ['beforeinput','input','change','keydown','keyup']) document.addEventListener(type,event=>records.push({type,target:event.target.id,trusted:event.isTrusted,value:event.target.value??event.target.textContent}));
</script>`;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/child' ? '<label>Child name<input value="child"></label><button>Child action</button>' : request.url === '/successor' ? '<h1>Successor document</h1>' : fixture);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseURL = 'http://127.0.0.1:' + server.address().port;
const outcomes = {};

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath() });
  const context = await browser.newContext({ baseURL });
  context.setDefaultTimeout(2000);
  const page = await context.newPage();
  const result = {};
  try {
    await page.goto('/');
    result.text = await page.getByText('Café 😃 hello', { exact: true }).textContent();
    assert.match(result.text, /Café/);
    assert.equal(await page.getByText(/another\s+hello/i).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Publish document', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Send', description: /your team/ }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Hidden button' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Hidden button', includeHidden: true }).count(), 1);
    assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 2);
    assert.equal(await page.getByLabel('E-mail address', { exact: true }).inputValue(), 'before');
    await assert.rejects(page.getByLabel('E-mail address').fill(42));
    await assert.rejects(page.locator('#select').selectOption({ label: 42 }));
    await assert.rejects(page.locator('#email').waitFor({ state: 'unknown' }));
    assert.equal(await page.getByPlaceholder('Your e-mail').getAttribute('id'), 'email');
    assert.equal(await page.getByAltText('A sunrise').count(), 1);
    assert.equal(await page.getByTitle('Dawn').count(), 1);
    assert.equal(await page.getByTestId('shadow').innerText(), 'Shadow action');
    assert.equal(await page.locator('css:light=button').filter({ hasText: 'Shadow' }).count(), 0);
    assert.equal(await page.getByText('Closed action').count(), 0);
    assert.equal(await page.getByText('Child action').count(), 0);
    const articles = page.getByTestId('list').locator('article');
    result.list = await articles.allTextContents();
    assert.deepEqual(result.list, ['AlphaA', 'BetaB']);
    assert.equal(await articles.filter({ has: page.getByRole('heading', { name: 'Beta' }) }).locator('p').innerText(), 'B');
    assert.equal(await articles.filter({ hasNot: page.getByText('Beta') }).count(), 1);
    assert.equal(await articles.filter({ hasText: /alpha/i }).count(), 1);
    assert.equal(await articles.filter({ hasNotText: 'Beta' }).count(), 1);
    assert.equal(await articles.nth(1).innerText(), 'Beta\n\nB');
    assert.equal(await articles.first().getByText('Alpha').count(), 1);
    assert.equal(await articles.last().locator(page.locator('p')).innerText(), 'B');
    assert.equal(await articles.and(page.locator('article').filter({ hasText: 'Beta' })).count(), 1);
    assert.equal(await page.getByText('Alpha', { exact: true }).or(page.getByText('Beta', { exact: true })).count(), 2);
    assert.equal((await articles.all()).length, 2);
    await assert.rejects(page.locator('article').textContent(), /strict mode violation/);
    const malformed = page.locator('css=[');
    await assert.rejects(malformed.count(), /selector|Unexpected token/i);
    assert.equal(await page.locator('#absent').isVisible(), false);
    assert.equal(await page.locator('#absent').isHidden(), true);
    assert.equal(await page.locator('#readonly').isEditable(), false);
    assert.equal(await page.locator('#disabled').isDisabled(), true);
    assert.equal(await page.locator('#email').isEnabled(), true);
    assert.equal(await page.locator('input[type=checkbox]').isChecked(), true);
    await assert.rejects(page.locator('#email').isChecked(), /checkbox|radio/);
    await assert.rejects(page.locator('#missing').textContent({ timeout: 80 }), error => error.name === 'TimeoutError');
    await assert.rejects(page.locator('#readonly').fill('blocked', { timeout: 80 }), error => error.name === 'TimeoutError');
    assert.equal(await page.locator('#readonly').inputValue(), 'unchanged');
    const waiting = page.locator('#pending').waitFor();
    await page.evaluate(() => { setTimeout(() => { document.querySelector('#pending').hidden = false; }, 40); });
    await waiting;
    const replacement = page.locator('#replacement');
    await page.evaluate(() => { document.querySelector('#replacement').outerHTML = '<div id="replacement">new element</div>'; });
    assert.equal(await replacement.textContent(), 'new element');
    await page.evaluate(() => {
      const element = document.createElement('span'); element.textContent = 'quotes " and >> and \ud800'; document.body.append(element);
      const hidden = document.createElement('div'); hidden.style.display = 'contents'; hidden.innerHTML = '<span>Display contents</span>'; hidden.id = 'contents'; document.body.append(hidden);
    });
    assert.equal(await page.getByText('quotes " and >> and \ud800', { exact: true }).count(), 1);
    assert.equal(await page.getByText(/quotes " and >>/).count(), 1);
    assert.equal(await page.locator('#contents').isVisible(), true);
    const late = page.getByTestId('late-shadow').waitFor();
    await page.evaluate(() => { const host = document.createElement('div'); document.body.append(host); host.attachShadow({ mode: 'open' }).innerHTML = '<span data-testid="late-shadow">late</span>'; });
    await late;
    const child = page.frame('child');
    assert.ok(child);
    assert.equal(await child.getByRole('button', { name: 'Child action' }).count(), 1);
    await child.getByLabel('Child name').fill('child updated');
    assert.equal(await child.getByLabel('Child name').inputValue(), 'child updated');
    assert.throws(() => page.locator('article').filter({ has: child.locator('button') }), /same frame/);

    await page.evaluate(() => { window.records = []; window.__flashwrightLocatorRuntime = { run: () => ({ status: 'success', value: { kind: 'number', value: 999 } }) }; });
    assert.equal(await page.locator('#email').count(), 1);
    await page.getByLabel('E-mail address').fill('réponse 😃');
    assert.equal(await page.locator('#email').inputValue(), 'réponse 😃');
    await page.locator('#email').clear();
    assert.equal(await page.locator('#email').inputValue(), '');
    await page.locator('#email').blur();
    await page.locator('#date').fill('2026-10-07');
    await page.locator('#area').fill('multiple\nlines');
    await page.locator('#editor').fill('editable text');
    assert.equal(await page.locator('#editor').textContent(), 'editable text');
    assert.deepEqual(await page.locator('#select').selectOption(['Red', 'blue']), ['red', 'blue']);
    assert.deepEqual(await page.locator('#select').selectOption([{ label: 'Red' }, { label: 'Blue sky' }]), ['red', 'blue']);
    assert.equal(await page.locator('#select').inputValue(), 'red');
    assert.deepEqual(await page.locator('#select').selectOption(null), []);
    await page.locator('#email').focus();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'email');
    result.input = await page.evaluate(() => records);
    assert.ok(result.input.some(event => event.type === 'input' && event.target === 'email' && event.trusted));
    const navigationWait = page.getByText('Successor document', { exact: true }).waitFor();
    await page.goto('/successor'); await navigationWait;
    assert.equal(await page.getByRole('heading').innerText(), 'Successor document');
    assert.equal(await page.locator('article').count(), 0);
    const pendingClose = page.locator('#missing').waitFor().then(() => 'resolved', () => 'closed');
    await page.close(); assert.equal(await pendingClose, 'closed');
    result.completed = true;
    outcomes[name] = result;
    console.log(`${name}: locator and text input corpus passed`);
  } finally { await browser.close(); }
}

try {
  await run('reference', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(outcomes.flashwright, outcomes.reference);
  await mkdir('compatibility/evidence', { recursive: true });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const destination = `compatibility/evidence/locators-${process.platform}-${process.arch}-${process.versions.node}.json`;
  await writeFile(destination, JSON.stringify({
    reference: '1.60.0', node: process.version, platform: process.platform, architecture: process.arch,
    fixtureSha256: hash(await readFile(new URL(import.meta.url))),
    driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes,
    scope: 'Experimental M2 locator reads, waits, same-process child frames, fill/select/focus; no pointer input or performance claim.',
  }, null, 2) + '\n');
  console.log(`Locator differential evidence: ${destination}`);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
