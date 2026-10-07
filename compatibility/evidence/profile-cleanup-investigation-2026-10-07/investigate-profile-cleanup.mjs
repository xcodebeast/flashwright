import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'flashwright';
for (let iteration = 0; iteration < 60; iteration++) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line));
  const guardian = processes.find(fields => Number(fields[2]) === browser.client.process.pid);
  const browserProcess = processes.find(fields => fields[2] === guardian[1] && fields[3].includes('--user-data-dir='));
  const profile = /--user-data-dir=(\S+)/.exec(browserProcess[3])[1];
  const crash = page.waitForEvent('crash');
  const navigation = page.goto('chrome://crash', { timeout: 2000 }).catch(error => error);
  await crash; await navigation;
  const replacement = await context.newPage();
  assert.equal(await replacement.evaluate(() => 42), 42);
  await replacement.close(); await page.close(); await browser.close();
  if (existsSync(profile)) {
    console.error(JSON.stringify({ iteration, profile, diagnostics: browser.client.diagnostics }));
    process.exitCode = 1; break;
  }
  if ((iteration + 1) % 10 === 0) console.log(`Completed ${iteration + 1} crash/close cycles without a profile leak.`);
}
