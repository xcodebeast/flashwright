import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';

const fixture = `<!doctype html><meta charset="utf-8"><style>
body { margin:0; font:16px sans-serif; } button, a { position:absolute; width:100px; height:40px; box-sizing:border-box; }
#button { left:20px; top:20px; border:4px solid black; } #other { left:150px; top:20px; }
#hidden { display:none; } #disabled { left:20px; top:90px; } #hazard { left:150px; top:90px; }
#moving { left:20px; top:160px; } #below { left:20px; top:1700px; }
#navigate { left:20px; top:230px; } #held { left:150px; top:230px; } #no-content { left:280px; top:230px; }
#check-label { position:absolute; top:290px; left:20px; } #radio-label { position:absolute; top:330px; left:20px; }
#refuse-label { position:absolute; top:290px; left:250px; }
#frame { position:absolute; top:400px; left:30px; width:300px; height:180px; border:6px solid black; padding:4px; }
#show { left:450px; top:20px; } #waiting { left:450px; top:90px; display:none; }
</style>
<button id="button">Button</button><button id="other">Other</button><button id="hidden">Hidden</button><button id="disabled" disabled>Disabled</button><button id="hazard">Hazard</button><button id="moving">Moving</button><button id="below">Below</button>
<a id="navigate" href="/destination">Navigate</a><a id="held" href="/held">Held</a><a id="no-content" href="/no-content">No content</a>
<label id="check-label"><input id="checkbox" type="checkbox"> Checkbox</label><label id="radio-label"><input id="radio" type="radio"> Radio</label>
<label id="refuse-label"><input id="refuse" type="checkbox" onclick="event.preventDefault()"> Refuse</label>
<button id="show" onclick="document.querySelector('#waiting').style.display='block'">Show</button><button id="waiting">Waiting</button>
<iframe id="frame" name="child" src="/child"></iframe>
<script>
window.records=[]; window.frameCount=0; requestAnimationFrame(function tick(){ frameCount++; requestAnimationFrame(tick); });
for (const type of ['pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup','click','dblclick','contextmenu','auxclick','keydown','keyup']) document.addEventListener(type, event => {
  records.push({type,target:event.target.id,trusted:event.isTrusted,button:event.button??null,buttons:event.buttons??null,detail:event.detail,shift:event.shiftKey,control:event.ctrlKey,alt:event.altKey,meta:event.metaKey,key:event.key??null});
});
window.clickFrames=[]; document.querySelector('#moving').addEventListener('mousedown', event=>clickFrames.push({frame:frameCount,left:event.target.getBoundingClientRect().left,x:event.clientX}));
</script>`;
const childFixture = `<!doctype html><style>body{margin:0}button{position:absolute;left:20px;top:20px;width:100px;height:40px}</style><button id="child-button" onclick="document.querySelector('output').textContent=String(event.isTrusted)">Child</button><output></output><iframe name="nested" style="position:absolute;top:75px;left:10px;width:150px;height:75px;border:3px solid black" src="/nested"></iframe>`;
const observers = new Map();
const heldResponses = new Map();
function nextRequest(path) { return new Promise(resolve => observers.set(path, resolve)); }
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (path === '/held') heldResponses.set(path, response);
  observers.get(path)?.(); observers.delete(path);
  if (path === '/held' || path === '/never-load' || path === '/never-navigation') return;
  if (path === '/destination') { setTimeout(() => response.end('<h1>Destination</h1><img src="/never-load">'), 100); return; }
  if (path === '/no-content') { response.writeHead(204); response.end(); return; }
  if (path === '/child') { response.end(childFixture); return; }
  if (path === '/nested') { response.end('<button onclick="this.textContent=String(event.isTrusted)">Nested</button>'); return; }
  response.end(fixture);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseURL = 'http://127.0.0.1:' + server.address().port;
const outcomes = {};

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath() });
  const context = await browser.newContext({ baseURL }); context.setDefaultTimeout(3000);
  const page = await context.newPage(); const result = {};
  async function reset() { await page.goto('/'); }
  async function events(operation) { await page.evaluate(() => { window.records = []; }); await operation(); return page.evaluate(() => records); }
  try {
    await reset();
    const otherPage = await context.newPage();
    result.backgroundPageState = await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() }));
    assert.deepEqual(result.backgroundPageState, { visibility: 'visible', focused: true });
    result.click = await events(() => page.locator('#button').click());
    await otherPage.close();
    console.log(`${name}: first native click passed`);
    assert.deepEqual(result.click.filter(event => event.type === 'click').map(event => [event.target, event.trusted]), [['button', true]]);
    result.doubleClick = await events(() => page.locator('#other').dblclick());
    assert.equal(result.doubleClick.filter(event => event.type === 'dblclick').length, 1);
    result.rightClick = await events(() => page.locator('#button').click({ button: 'right' }));
    result.middleClick = await events(() => page.locator('#other').click({ button: 'middle' }));
    result.modifiers = await events(() => page.locator('#button').click({ modifiers: ['Shift', 'Alt'], delay: 5 }));
    result.modifiersWithoutDelay = await events(() => page.locator('#other').click({ modifiers: ['Shift', 'Alt'], delay: 0 }));
    result.tripleClick = await events(() => page.locator('#button').click({ clickCount: 3 }));
    assert.deepEqual(result.tripleClick.filter(event => event.type === 'click').map(event => event.detail), [1, 2, 3]);
    result.maximumClickCount = await events(() => page.locator('#other').click({ clickCount: 100 }));
    assert.deepEqual(result.maximumClickCount.filter(event => event.type === 'click').map(event => event.detail), Array.from({ length: 100 }, (_, index) => index + 1));
    result.delayedDoubleClick = await events(() => page.locator('#button').dblclick({ delay: 5 }));
    assert.equal(result.delayedDoubleClick.filter(event => event.type === 'dblclick').length, 1);
    result.trial = await events(() => page.locator('#other').click({ trial: true, modifiers: ['Shift'] }));
    assert.equal(result.trial.filter(event => event.type === 'click').length, 0);
    result.hover = await events(() => page.locator('#disabled').hover());
    assert.ok(result.hover.some(event => event.type === 'mousemove' && event.target === 'disabled'));
    await page.evaluate(() => { window.point = null; document.querySelector('#button').addEventListener('mousedown', event => { window.point = { x: event.clientX, y: event.clientY }; }, { once: true }); });
    await page.locator('#button').click({ position: { x: 7, y: 9 } });
    result.position = await page.evaluate(() => point); assert.deepEqual(result.position, { x: 31, y: 33 });
    console.log(`${name}: event and option cases passed`);
    await assert.rejects(page.locator('#hidden').click({ force: true }), /visible|viewport/);
    await assert.rejects(page.locator('button').click(), /strict mode violation/);
    await assert.rejects(page.locator('#disabled').click({ timeout: 100 }), error => error.name === 'TimeoutError');
    await page.evaluate(() => { setTimeout(() => { document.querySelector('#disabled').disabled = false; }, 50); });
    await page.locator('#disabled').click();
    await page.getByLabel('Checkbox', { exact: true }).check();
    assert.equal(await page.locator('#checkbox').isChecked(), true);
    const unchanged = await events(() => page.locator('#checkbox').check()); assert.equal(unchanged.length, 0);
    await page.locator('#checkbox').uncheck(); assert.equal(await page.locator('#checkbox').isChecked(), false);
    await page.locator('#checkbox').setChecked(true); assert.equal(await page.locator('#checkbox').isChecked(), true);
    await page.locator('#checkbox').uncheck({ trial: true }); assert.equal(await page.locator('#checkbox').isChecked(), true);
    await page.locator('#radio').check();
    await assert.rejects(page.locator('#radio').uncheck(), /Cannot uncheck radio/);
    await assert.rejects(page.locator('#refuse').check(), /did not change/);
    await page.locator('#below').click();
    assert.ok(await page.evaluate(() => scrollY > 0));
    console.log(`${name}: state and scroll cases passed`);

    const oldFrames = page.frames().filter(frame => frame !== page.mainFrame());
    await reset();
    assert.ok(oldFrames.every(frame => frame.isDetached()));
    assert.equal(page.frames().length, 3);
    await page.frame('child').getByRole('button', { name: 'Child', exact: true }).click();
    assert.equal(await page.frame('child').locator('output').textContent(), 'true');
    await page.frame('nested').getByRole('button', { name: 'Nested' }).click();
    assert.equal(await page.frame('nested').getByRole('button').textContent(), 'true');
    await page.evaluate(() => { const cover = document.createElement('div'); cover.id = 'cover'; cover.title = '\uD800'; cover.style.cssText = 'position:absolute;left:0;top:390px;width:400px;height:210px;background:red;z-index:100'; document.body.append(cover); });
    await assert.rejects(page.frame('child').getByRole('button', { name: 'Child' }).click({ timeout: 120 }), error => error.name === 'TimeoutError');
    await page.evaluate(() => document.querySelector('#cover').remove());
    await page.frame('child').getByRole('button', { name: 'Child' }).click();
    await page.evaluate(() => { document.querySelector('#frame').style.transform = 'rotate(8deg) scale(0.8)'; });
    await page.frame('child').getByRole('button', { name: 'Child' }).click();
    await page.frame('nested').getByRole('button', { name: 'true' }).click();
    console.log(`${name}: child-frame cases passed`);

    await reset();
    await page.evaluate(() => {
      window.hazardClicks = 0; window.overlayClicks = 0;
      const target = document.querySelector('#hazard');
      target.addEventListener('click', () => hazardClicks++);
      target.addEventListener('mousemove', () => {
        const cover = document.createElement('div'); cover.style.cssText = 'position:absolute;left:150px;top:90px;width:100px;height:40px;z-index:10;background:red';
        cover.addEventListener('click', () => overlayClicks++); document.body.append(cover); setTimeout(() => cover.remove(), 80);
      }, { once: true });
    });
    await page.locator('#hazard').click();
    result.hitGuard = await page.evaluate(() => ({ target: hazardClicks, overlay: overlayClicks })); assert.deepEqual(result.hitGuard, { target: 1, overlay: 0 });
    await page.evaluate(() => {
      const target = document.querySelector('#moving'); window.beforeFrame = frameCount;
      requestAnimationFrame(() => { target.style.left = '180px'; requestAnimationFrame(() => { target.style.left = '280px'; }); });
    });
    await page.locator('#moving').click();
    const stability = await page.evaluate(() => ({ delta: clickFrames[0].frame - beforeFrame, left: clickFrames[0].left, x: clickFrames[0].x }));
    assert.ok(stability.delta >= 2); assert.equal(stability.left, 280); assert.equal(stability.x, 330);
    await Promise.all([page.locator('#waiting').click(), page.locator('#show').click()]);
    assert.equal(await page.locator('#waiting').isVisible(), true);
    console.log(`${name}: hit guard, stability and concurrency cases passed`);

    await reset();
    await page.locator('#navigate').click({ timeout: 1500 });
    assert.equal(page.url(), baseURL + '/destination');
    assert.equal(await page.getByRole('heading').textContent(), 'Destination');
    await assert.rejects(page.waitForLoadState('load', { timeout: 80 }), error => error.name === 'TimeoutError');
    result.navigationCommittedWithoutLoad = true;
    console.log(`${name}: navigation commit barrier passed`);
    await reset();
    await page.locator('#no-content').click({ timeout: 1500 }); assert.equal(page.url(), baseURL + '/');
    const observed = nextRequest('/held');
    const clicked = page.locator('#held').click({ noWaitAfter: true });
    await observed; await clicked; assert.equal(page.url(), baseURL + '/');
    heldResponses.get('/held').end('<h1>Released</h1>'); heldResponses.delete('/held');
    await page.waitForURL('**/held');
    await reset();
    await page.evaluate(() => { document.querySelector('#navigate').href = '/never-navigation'; });
    await assert.rejects(page.locator('#navigate').click({ timeout: 200 }), error => error.name === 'TimeoutError');
    await reset();
    result.complete = true;
    outcomes[name] = result; console.log(`${name}: native pointer corpus passed`);
  } finally { await browser.close(); }
}

try {
  await run('reference', referenceChromium); await run('flashwright', flashwrightChromium);
  assert.deepEqual(outcomes.flashwright, outcomes.reference);
  await mkdir('compatibility/evidence', { recursive: true });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const destination = `compatibility/evidence/pointer-${process.platform}-${process.arch}-${process.versions.node}.json`;
  await writeFile(destination, JSON.stringify({ reference: '1.60.0', node: process.version, platform: process.platform, architecture: process.arch, fixtureSha256: hash(await readFile(new URL(import.meta.url))), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes, scope: 'Experimental native pointer/actionability/navigation differential; no performance claim.' }, null, 2) + '\n');
  console.log(`Pointer differential evidence: ${destination}`);
} finally { for (const response of heldResponses.values()) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
