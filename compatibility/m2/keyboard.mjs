import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';

const fixture = `<!doctype html><meta charset="utf-8"><input id="input" value="original"><input id="second"><textarea id="textarea"></textarea>
<div id="editable" contenteditable>original</div><button id="button" onclick="this.dataset.trusted=String(event.isTrusted)">Button</button>
<input id="disabled" disabled><input id="hidden" style="display:none"><div id="shadow"></div>
<a id="navigate" href="/destination">Navigate</a><a id="held" href="/held">Held</a><a id="no-content" href="/no-content">No content</a>
<iframe name="child" src="/child"></iframe><script>
window.records=[];
for (const type of ['focusin','keydown','keypress','keyup','beforeinput','input','click']) document.addEventListener(type, event => {
 records.push({type,target:event.target.id,key:event.key??null,code:event.code??null,keyCode:event.keyCode??null,charCode:event.charCode??null,location:event.location??null,repeat:event.repeat??null,shift:event.shiftKey??null,control:event.ctrlKey??null,alt:event.altKey??null,meta:event.metaKey??null,data:event.data??null,inputType:event.inputType??null,trusted:event.isTrusted});
});
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input id="shadow-input">';
</script>`;
const heldResponses = new Map();
const observers = new Map();
const server = createServer((request, response) => {
 const path = new URL(request.url, 'http://fixture').pathname;
 response.setHeader('content-type', 'text/html; charset=utf-8');
 if (path === '/held') heldResponses.set(path, response);
 observers.get(path)?.(); observers.delete(path);
 if (['/held', '/never-load', '/never-navigation'].includes(path)) return;
 if (path === '/destination') { setTimeout(() => response.end('<h1>Destination</h1><img src="/never-load">'), 80); return; }
 if (path === '/no-content') { response.writeHead(204); response.end(); return; }
 if (path === '/child') { response.end('<input id="child-input" oninput="this.dataset.trusted=String(event.isTrusted)">'); return; }
 response.end(fixture);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseURL = 'http://127.0.0.1:' + server.address().port;
const outcomes = {};

async function run(name, chromium) {
 const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath() });
 const context = await browser.newContext({ baseURL }); context.setDefaultTimeout(4000);
 const page = await context.newPage(); const result = {};
 const reset = () => page.goto('/');
 async function events(operation) { await page.evaluate(() => { records = []; }); await operation(); return page.evaluate(() => records); }
 try {
  await reset();
  for (const key of ['a', 'A', 'Shift+KeyA', 'Shift+a', '+', 'Shift+Digit1', 'NumpadAdd', 'Shift+Numpad8', 'Control+Shift+KeyB', 'a+a', 'Control+Control+a', 'ArrowLeft', 'Shift+ArrowRight', 'Delete', 'Backspace', 'Tab']) {
   await page.evaluate(() => { const input = document.querySelector('#input'); input.value = 'original'; input.blur(); });
   result[key] = { events: await events(() => page.locator('#input').press(key)), value: await page.locator('#input').inputValue() };
  }
  await page.evaluate(() => { globalThis.preventKeyDefault = event => event.preventDefault(); document.addEventListener('keydown', preventKeyDefault); });
  result.layout = {};
  const layout = JSON.parse(await readFile('crates/flashwright-engine/src/keyboard-layout.json', 'utf8'));
  for (const key of Object.keys(layout.keys)) result.layout[key] = await events(() => page.locator('#input').press(key));
  await page.evaluate(() => document.removeEventListener('keydown', preventKeyDefault));
  console.log(`${name}: all ${Object.keys(layout.keys).length} key descriptions and chord events passed`);
  await page.locator('#input').focus();
  await page.evaluate(() => document.addEventListener('keydown', preventKeyDefault));
  result.pageLayout = {};
  for (const key of Object.keys(layout.keys)) result.pageLayout[key] = await events(() => page.keyboard.press(key));
  await page.evaluate(() => document.removeEventListener('keydown', preventKeyDefault));
  await page.locator('#input').fill('abcd');
  await page.evaluate(() => document.querySelector('#input').setSelectionRange(1,3));
  result.pageSelection = await events(() => page.keyboard.press('z'));
  assert.equal(await page.locator('#input').inputValue(), 'azd');
  page.setDefaultTimeout(1);
  await page.keyboard.press('b', { delay: 40 });
  page.setDefaultTimeout(4000);
  assert.equal(await page.locator('#input').inputValue(), 'azbd');
  await page.locator('#shadow-input').focus(); await page.keyboard.press('p');
  assert.equal(await page.locator('#shadow-input').inputValue(), 'p');
  await page.frame('child').locator('#child-input').focus(); await page.keyboard.press('f');
  assert.equal(await page.frame('child').locator('#child-input').inputValue(), 'f');
  await reset();
  result.unfocused = await events(() => page.keyboard.press('a'));
  assert.equal(await page.locator('#input').inputValue(), 'original');
  console.log(`${name}: all page-level key descriptions, existing focus and selection passed`);
  await page.locator('#input').fill('select this');
  result.selectAll = await events(() => page.locator('#input').press('ControlOrMeta+A'));
  await page.locator('#input').press('z'); assert.equal(await page.locator('#input').inputValue(), 'z');
  await page.locator('#textarea').press('Enter'); assert.equal(await page.locator('#textarea').inputValue(), '\n');
  result.editable = await events(() => page.locator('#editable').press('ControlOrMeta+A'));
  await page.locator('#editable').press('r'); assert.equal(await page.locator('#editable').textContent(), 'r');
  await page.locator('#button').press('Enter'); assert.equal(await page.locator('#button').getAttribute('data-trusted'), 'true');
  await page.locator('#shadow-input').press('s'); assert.equal(await page.locator('#shadow-input').inputValue(), 's');
  const child = page.frame('child').locator('#child-input'); await child.press('c'); assert.equal(await child.inputValue(), 'c'); assert.equal(await child.getAttribute('data-trusted'), 'true');
  await page.locator('#second').focus();
  result.disabled = await events(() => page.locator('#disabled').press('d'));
  result.hidden = await events(() => page.locator('#hidden').press('h'));
  result.nonfocusable = await events(() => page.locator('body').press('b'));
  result.previousFocusValue = await page.locator('#second').inputValue();
  await assert.rejects(page.locator('input').press('a'), /strict mode violation/);
  await assert.rejects(page.locator('#missing').press('a', { timeout: 80 }), error => error.name === 'TimeoutError');
  await page.evaluate(() => { setTimeout(() => { const input = document.createElement('input'); input.id = 'late'; document.body.append(input); }, 40); });
  await page.locator('#late').press('l'); assert.equal(await page.locator('#late').inputValue(), 'l');
  result.delay = await events(() => page.locator('#input').press('Shift+KeyZ', { delay: 5 }));
  console.log(`${name}: focus, editing, shadow and frame cases passed`);

  await reset();
  await page.locator('#navigate').press('Enter');
  assert.equal(page.url(), baseURL + '/destination');
  await assert.rejects(page.waitForLoadState('load', { timeout: 80 }), error => error.name === 'TimeoutError');
  await reset(); await page.locator('#no-content').press('Enter'); assert.equal(page.url(), baseURL + '/');
  const observed = new Promise(resolve => observers.set('/held', resolve));
  const pressed = page.locator('#held').press('Enter', { noWaitAfter: true });
  await observed; await pressed; assert.equal(page.url(), baseURL + '/');
  heldResponses.get('/held').end('<h1>Released</h1>'); heldResponses.delete('/held'); await page.waitForURL('**/held');
  await reset(); await page.locator('#held').focus();
  const observedPagePress = new Promise(resolve => observers.set('/held', resolve));
  const pagePress = page.keyboard.press('Enter');
  await observedPagePress; await pagePress; assert.equal(page.url(), baseURL + '/');
  heldResponses.get('/held').end('<h1>Released page key</h1>'); heldResponses.delete('/held');
  await page.waitForURL('**/held');
  await reset(); await page.evaluate(() => { document.querySelector('#navigate').href = '/never-navigation'; });
  await assert.rejects(page.locator('#navigate').press('Enter', { timeout: 200 }), error => error.name === 'TimeoutError');
  await reset();
  for (const key of ['NotAKey', '\uD800']) {
   await assert.rejects(page.locator('#input').press(key), /Unknown key/);
   await assert.rejects(page.keyboard.press(key), /Unknown key/);
  }
  if (name === 'flashwright') {
   const invalid = await events(async () => {
    await assert.rejects(page.keyboard.press('Shift+NotAKey'), /Unknown key/);
    await assert.rejects(page.keyboard.press('a', { noWaitAfter:true }), error => error.name === 'UnsupportedFeatureError');
    await assert.rejects(page.keyboard.down('Shift'), error => error.name === 'UnsupportedFeatureError');
   });
   assert.deepEqual(invalid, []);
  }
  result.complete = true; outcomes[name] = result;
  console.log(`${name}: native keyboard corpus passed`);
 } finally { await browser.close(); }
}
try {
 await run('reference', referenceChromium); await run('flashwright', flashwrightChromium);
 assert.deepEqual(outcomes.flashwright, outcomes.reference);
 await mkdir('compatibility/evidence', { recursive: true });
 const hash = value => createHash('sha256').update(value).digest('hex');
 const destination = process.argv[2] ?? `compatibility/evidence/keyboard-${process.platform}-${process.arch}-${runtimeArtifactLabel}.json`;
 await writeFile(destination, JSON.stringify({ reference: '1.60.0', ...runtimeMetadata, platform: process.platform, architecture: process.arch, fixtureSha256: hash(await readFile(new URL(import.meta.url))), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes, scope: 'Experimental native keyboard differential; no performance claim.' }, null, 2) + '\n');
 console.log(`Keyboard differential evidence: ${destination}`);
} finally { for (const response of heldResponses.values()) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
