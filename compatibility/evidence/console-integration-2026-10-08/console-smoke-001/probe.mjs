import { chromium } from 'flashwright';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
const messages = [];
try {
  const page = await browser.newPage();
  page.on('console', message => messages.push(message));
  await page.evaluate(() => {
    console.log('plain', 42, -0, NaN, Infinity, undefined, null, true, '\ud800\udfff\0');
    console.log('%s:%d', 'word', 7);
    console.log({ answer: 42, nested: { value: 7 }, get getter() { throw new Error('getter'); }, 'é\ud800': '\udfff' });
    console.log([1, , 3]); console.log(new Map([['key', 7]])); console.log(document.body);
    console.log(new Date('2024-01-01'), /hello/gi, Symbol('unique'), value => value);
    console.log(42n);
    console.warn('warning'); console.error('error'); console.info('info'); console.debug('debug');
    console.assert(false, 'assertion', 42); console.trace('trace'); console.dir({ answer: 42 }); console.dirxml(document.body);
    console.table([{ column: 1 }]); console.group('group'); console.groupCollapsed('collapsed'); console.groupEnd(); console.groupEnd();
    console.count('count'); console.countReset('count'); console.clear(); console.log('after clear');
  });
  const outcomes = [];
  for (const message of messages) {
    const values = [];
    for (const argument of message.args()) {
      try { const value = await argument.jsonValue(); values.push({ type: typeof value, text: String(value) }); }
      catch (error) { values.push({ error: error.message }); }
    }
    outcomes.push({ type: message.type(), text: message.text(), previews: message.args().map(argument => argument.toString()), location: message.location(), timestamp: message.timestamp(), page: message.page() === page, worker: message.worker(), values });
  }
  await writeFile('.cache/console-smoke-001/report.json', JSON.stringify(outcomes, null, 2) + '\n');
} finally { await browser.close(); }
