import assert from 'node:assert/strict';
import { chromium } from 'flashwright';

for (let round = 0; round < 3; round++) {
  const outcomes = await Promise.allSettled([chromium.launch({ timeout: 5000 }), chromium.launch({ timeout: 5000 })]);
  const browsers = outcomes.filter(outcome => outcome.status === 'fulfilled').map(outcome => outcome.value);
  try {
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    assert.equal(browsers.length, 2);
    const pages = await Promise.all(browsers.map(browser => browser.newPage()));
    await Promise.all(pages.map((page, index) => page.evaluate(owner => { globalThis.launchOwner = owner; }, index)));
    assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(() => globalThis.launchOwner))), [0, 1]);
    await browsers[0].close();
    assert.equal(await pages[1].evaluate(() => globalThis.launchOwner), 1);
  } finally {
    await Promise.all(browsers.map(browser => browser.close()));
  }
}
console.log('Concurrent launch passed: independent replies, page ownership and surviving browser after peer closure.');
