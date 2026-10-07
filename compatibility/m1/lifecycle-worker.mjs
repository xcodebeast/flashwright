import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { EngineClient } from '../../packages/flashwright/dist/commonjs/client.js';

const client = new EngineClient(process.env.FLASHWRIGHT_DRIVER_PATH);
client.retain();
const browser = await client.request('browser.launch', { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH, headless: true }, 30000);
const context = await client.request('browser.newContext', { browser: browser.identifier });
const page = await client.request('context.newPage', { context: context.identifier });
const heartbeat = setInterval(() => {}, 1000);
console.log(JSON.stringify({ ready: true, guardian: browser.processIdentifier }));

function evaluate(source, timeout = 0) {
  return client.request('page.evaluate', {
    page: page.identifier, source: Array.from({ length: source.length }, (_, index) => source.charCodeAt(index)),
    isFunction: false, argument: { kind: 'undefined' },
  }, timeout);
}

const commands = createInterface({ input: process.stdin });
for await (const command of commands) {
  if (command === 'blocked-renderer') {
    const started = performance.now();
    await assert.rejects(evaluate('while (true) {}', 100), error => error.name === 'TimeoutError');
    const result = await evaluate('42', 1000);
    assert.deepEqual(result, { kind: 'number', value: 42 });
    console.log(JSON.stringify({ recovered: true, elapsedMilliseconds: performance.now() - started }));
  } else if (command === 'driver-deadline') {
    const started = performance.now();
    await assert.rejects(evaluate('42', 100), error => error.name === 'TimeoutError');
    console.log(JSON.stringify({ hostDeadline: true, elapsedMilliseconds: performance.now() - started }));
  } else if (command === 'close') {
    await client.request('browser.close', { browser: browser.identifier });
    await client.release();
    break;
  }
}
clearInterval(heartbeat);
commands.close();
process.stdin.destroy();
