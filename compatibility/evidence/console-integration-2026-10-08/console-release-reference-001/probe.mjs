import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
const outcomes = {};
try {
 const context = await browser.newContext(); const page = await context.newPage(); const session = await context.newCDPSession(page);
 for (const identifier of ['invalid', '1.1.1']) {
  try {outcomes[identifier] = await session.send('Runtime.releaseObject', { objectId: identifier });} catch(error) {outcomes[identifier] = error.message;}
 }
} finally {await browser.close();await writeFile('.cache/console-release-reference-001/report.json', JSON.stringify(outcomes,null,2)+'\n');}
