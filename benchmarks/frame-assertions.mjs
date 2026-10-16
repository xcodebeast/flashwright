import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as reference } from 'playwright';
import { expect as referenceExpect } from '../packages/flashwright-runner/dist/upstream/test.mjs';
import { chromium as candidate } from 'flashwright';
import { expect as candidateExpect } from '@flashwright/test';

// Usage: bun benchmarks/frame-assertions.mjs reference|control|lease identity output-directory [1|4]
// Set FLASHWRIGHT_BROWSER_PATH and FLASHWRIGHT_DRIVER_PATH to the pinned executables.
const [mode, identity, directory, concurrency = '1'] = process.argv.slice(2);
assert(['1', '4'].includes(concurrency));
assert(identity && directory);
await mkdir(directory, { recursive: true });
if (mode === 'control') process.env.FLASHWRIGHT_FRAME_ASSERTION_LEASES = '0';
else delete process.env.FLASHWRIGHT_FRAME_ASSERTION_LEASES;
assert(['reference', 'control', 'lease'].includes(mode));
const membership = (await readFile('/proc/self/cgroup', 'utf8')).trim();
const group = '/sys/fs/cgroup' + membership.split('::')[1];
// Only an explicitly delegated diagnostic owner group is meaningful here.
// Ordinary invocations still reproduce elapsed work without claiming tree CPU.
const collectCpu = group.endsWith('/owner');
async function counters() {
  if (!collectCpu) return null;
  const before = process.hrtime.bigint();
  const raw = await readFile(join(group, 'cpu.stat'), 'utf8');
  const after = process.hrtime.bigint();
  return { beforeNanoseconds: String(before), afterNanoseconds: String(after), raw,
    usageMicroseconds: Number(raw.match(/^usage_usec (\d+)$/m)[1]) };
}
const report = { status: 'running', mode, identity, ownerProcess: process.pid, membership, phases: {},
  scope: 'Preparation-inclusive mixed remote-frame assertion engineering screen. Cgroup phases include the watchdog and workload. No final resource or representative-majority performance admission.' };
const start = performance.now();
let port, browser;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/child' ? '<p id="value">before</p>' : `<iframe name="child" id="child" src="http://localhost:${port}/child"></iframe>`);
});
try {
  server.listen(0); await once(server, 'listening'); port = server.address().port;
  const chromium = mode === 'reference' ? reference : candidate;
  const expect = mode === 'reference' ? referenceExpect : candidateExpect;
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  const pages = [];
  for (let worker = 0; worker < Number(concurrency); worker++) {
    const context = await browser.newContext();
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
    const child = page.frame('child'), target = page.frameLocator('#child').locator('#value');
    assert(child);
    if (mode === 'reference') {
      const session = await context.newCDPSession(page);
      try { const {targetInfos} = await session.send('Target.getTargets'); assert(targetInfos.some(target => target.type === 'iframe' && target.url === `http://localhost:${port}/child`)); }
      finally { await session.detach(); }
    } else await assert.rejects(target.fill('unadmitted'), error => error.name === 'UnsupportedFeatureError' && /out-of-process/.test(error.message));
    pages.push({context, child, target});
  }
  report.concurrency = Number(concurrency);
  report.preparationMilliseconds = performance.now() - start;
  for (const phase of ['already-true', 'delayed', 'timeout']) {
    const row = { before: await counters(), durations: [], expectedTimeouts: 0 };
    report.phases[phase] = row;
    const count = phase === 'already-true' ? 128 : phase === 'delayed' ? 64 : 4;
    const phaseStart = performance.now();
    await Promise.all(pages.map(async ({child, target}) => {
      for (let index = 0; index < count; index++) {
        const iterationStart = performance.now();
        if (phase === 'delayed') {
          await child.evaluate(delay => {
            document.querySelector('#value').textContent = 'before';
            setTimeout(() => document.querySelector('#value').textContent = 'after', delay);
          }, index % 2 ? 24 : 8);
          await expect(target).toHaveText('after', { timeout: 2000 });
        } else if (phase === 'already-true') await expect(target).toHaveText('before');
        else {
          await assert.rejects(expect(target).toHaveText('never', { timeout: 150 }), error => /never/.test(error.message) && /after/.test(error.message));
          row.expectedTimeouts++;
        }
        row.durations.push(performance.now() - iterationStart);
      }
    }));
    row.elapsedMilliseconds = performance.now() - phaseStart;
    row.after = await counters();
    row.cpuMicroseconds = collectCpu ? row.after.usageMicroseconds - row.before.usageMicroseconds : null;
  }
  await Promise.all(pages.map(({context}) => context.close()));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  try { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
  catch (error) { report.status = 'failed'; report.cleanupError = error.stack; process.exitCode = 1; }
  report.preparationWorkAndTeardownMilliseconds = performance.now() - start;
  await writeFile(join(directory, 'payload.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
