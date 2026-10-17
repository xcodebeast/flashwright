import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium as reference } from 'playwright';

// Usage: bun benchmarks/snapshot-capture.mjs candidate|reference workload output-directory
// Set FLASHWRIGHT_BROWSER_PATH and, for candidate, FLASHWRIGHT_DRIVER_PATH.
// FLASHWRIGHT_SNAPSHOT_LIBRARY can select a separately built matching library entry for an older driver.
const [engine, workload, destination] = process.argv.slice(2);
assert.ok(['candidate', 'reference'].includes(engine));
assert.ok(['large-ascii', 'small-ascii', 'large-unicode', 'forms-shadow', 'large-churn'].includes(workload));
assert.ok(destination);
const { chromium: candidate } = await import(process.env.FLASHWRIGHT_SNAPSHOT_LIBRARY
  ? pathToFileURL(resolve(process.env.FLASHWRIGHT_SNAPSHOT_LIBRARY)).href : 'flashwright');
const require = createRequire(import.meta.url);
const { utils, iso } = require('playwright-core/lib/coreBundle');
const output = resolve(destination);
await mkdir(output, { recursive: false });
const rows = workload === 'small-ascii' ? 20 : workload === 'forms-shadow' ? 300 : 1500;
const metadata = workload === 'large-unicode' ? 'métadonnées Δ 😀 ' : 'repeated metadata ';
const hash = value => createHash('sha256').update(value).digest('hex');
const report = {
  status: 'running', engine, workload,
  scope: 'Synthetic complete browser trace flow; ordinary snapshots, no screenshots or source embedding. No representative-suite or final resource acceptance.',
  driverSha256: engine === 'candidate' ? hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)) : null,
  browserSha256: hash(await readFile(process.env.FLASHWRIGHT_BROWSER_PATH)),
  sourceSha256: hash(await readFile(new URL(import.meta.url))), outcomes: [],
};
const html = '<!doctype html><html><head><style>body{margin:0}header{position:sticky;top:0;background:white}td{padding:2px}</style></head><body><header><input id="filter"><button id="apply">Apply</button><output id="result">0</output></header><table>'
  + Array.from({ length: rows }, (_, index) => `<tr data-key="${index}" title="${metadata.repeat(12)}"><td>Item ${index}</td><td class="value">${index}</td></tr>`).join('')
  + '</table>'
  + (workload === 'forms-shadow' ? '<input id="live-value"><input id="live-check" type="checkbox"><select><option>A</option><option id="live-option">B</option></select><div id="shadow"></div>' : '')
  + '<script>window.trusted=0;document.querySelector("#apply").addEventListener("click",e=>{if(e.isTrusted)trusted++;const v=document.querySelector("#filter").value;document.querySelector("#result").textContent=v;document.querySelectorAll(".value")[Number(v)].textContent="updated "+v;});'
  + (workload === 'large-churn' ? 'document.querySelector("#apply").addEventListener("click",()=>{for(const row of document.querySelectorAll("tr")){row.title="churn "+trusted+" row "+row.dataset.key;row.cells[0].textContent="changed "+trusted+" row "+row.dataset.key;}});' : '')
  + (workload === 'forms-shadow' ? 'const shadow=document.querySelector("#shadow").attachShadow({mode:"open"});shadow.innerHTML="<span>retained shadow</span>";const sheet=new CSSStyleSheet();sheet.replaceSync("span{color:rgb(1,2,3)}");shadow.adoptedStyleSheets=[sheet];document.querySelector("#apply").addEventListener("click",()=>{document.querySelector("#live-value").value="live "+trusted;document.querySelector("#live-check").checked=true;document.querySelector("#live-option").selected=true;sheet.cssRules[0].style.color="rgb(4, 5, 6)";});' : '')
  + '</script></body></html>';
report.fixtureSha256 = hash(html);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
const started = performance.now();
try {
  browser = await (engine === 'reference' ? reference : candidate).launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  context.setDefaultTimeout(5000);
  await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
  const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const actions = performance.now();
  for (let index = 0; index < 12; index++) {
    await page.locator('#filter').fill(String(index)); await page.locator('#apply').click();
    assert.equal(await page.locator('#result').textContent(), String(index));
    assert.equal(await page.locator('.value').nth(index).textContent(), `updated ${index}`);
    report.outcomes.push(index);
  }
  report.final = await page.evaluate(() => ({ trusted: window.trusted, title: document.querySelector('tr').title }));
  assert.equal(report.final.trusted, 12);
  assert.equal(report.final.title, workload === 'large-churn' ? 'churn 12 row 0' : metadata.repeat(12));
  if (workload === 'forms-shadow') {
    report.dynamic = await page.evaluate(() => ({ value: document.querySelector('#live-value').value, checked: document.querySelector('#live-check').checked, selected: document.querySelector('#live-option').selected, css: document.querySelector('#shadow').shadowRoot.adoptedStyleSheets[0].cssRules[0].style.color }));
    assert.deepEqual(report.dynamic, { value: 'live 12', checked: true, selected: true, css: 'rgb(4, 5, 6)' });
  }
  report.actionsMilliseconds = performance.now() - actions;
  const stop = performance.now();
  await context.tracing.stop({ path: join(output, 'trace.zip') });
  report.exportMilliseconds = performance.now() - stop;
  await context.close(); await browser.close(); browser = undefined;
  report.completeMilliseconds = performance.now() - started;
  // Verification is outside the browser-flow timer, but inside an external supervisor's whole-command interval.
  const archive = new utils.ZipFile(join(output, 'trace.zip'));
  try {
    const entries = await archive.entries(); const traceNames = entries.filter(name => name.endsWith('.trace'));
    assert.ok(traceNames.length);
    const records = [];
    for (const name of traceNames) records.push(...(await archive.read(name)).toString().trim().split('\n').filter(Boolean).map(JSON.parse));
    const snapshots = records.filter(record => record.type === 'frame-snapshot').map(record => record.snapshot);
    assert.ok(snapshots.length >= 48);
    const storage = new iso.SnapshotStorage(); let rendered = 0, lastContent;
    for (const snapshot of snapshots) {
      lastContent = storage.addFrameSnapshot('context', snapshot, []).render().html;
      assert.ok(typeof lastContent === 'string' && lastContent.length); rendered++;
    }
    if (workload === 'large-churn') {
      for (let index = 0; index < rows; index++) {
        assert.ok(lastContent.includes(`churn 12 row ${index}`));
        assert.ok(lastContent.includes(`changed 12 row ${index}`));
      }
    } else assert.ok(lastContent.includes(metadata.repeat(12)), 'archive replay retains exact Unicode/ASCII metadata');
    if (workload === 'forms-shadow') for (const marker of ['live 12', 'retained shadow', 'rgb(4, 5, 6)', '__playwright_checked_', '__playwright_selected_']) assert.ok(lastContent.includes(marker), marker);
    report.snapshots = { count: snapshots.length, rendered, collectionMilliseconds: snapshots.reduce((sum, snapshot) => sum + (snapshot.collectionTime ?? 0), 0), maximumCollectionMilliseconds: Math.max(...snapshots.map(snapshot => snapshot.collectionTime ?? 0)), bytes: (await stat(join(output, 'trace.zip'))).size };
  } finally { archive.close(); }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  try { await browser?.close(); }
  catch (error) { report.status = 'failed'; report.cleanupError = error.stack; process.exitCode = 1; }
  server.close(); await once(server, 'close');
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report));
}
