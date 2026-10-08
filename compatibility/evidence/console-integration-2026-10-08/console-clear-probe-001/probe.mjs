import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
const outcomes = {};
for (const [name, chromium] of [['reference', referenceChromium], ['flashwright', flashwrightChromium]]) {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  try {
    const page = await browser.newPage();
    const next = page.waitForEvent('console');
    await page.evaluate(() => console.log({ answer: 42 }));
    const argument = (await next).args()[0];
    await page.evaluate(() => console.clear());
    await argument.dispose();
    assert.equal(await page.evaluate(() => 42), 42);
    outcomes[name] = { disposedAfterClear: true, pageRemainsUsable: true };
  } finally { await browser.close(); }
}
await writeFile('.cache/console-clear-probe-001/report.json', JSON.stringify(outcomes, null, 2) + '\n');
