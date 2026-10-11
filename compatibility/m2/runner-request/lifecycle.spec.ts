import { appendFile } from 'node:fs/promises';
import { test as base, expect, request as requestFactory, type APIRequestContext } from '@flashwright/test';

const contexts: APIRequestContext[] = [];
const originalNewContext = requestFactory.newContext.bind(requestFactory);
requestFactory.newContext = async options => {
  const context = await originalNewContext(options);
  contexts.push(context);
  return context;
};

async function record(event: object) {
  await appendFile(process.env.FLASHWRIGHT_REQUEST_LIFECYCLE_LOG!, JSON.stringify(event) + '\n');
}

// Automatic fixtures precede named fixtures, so this teardown observes actual
// request-fixture disposal instead of taking over its cleanup responsibility.
const test = base.extend<{ verifyRequestRetirement: void }>({
  verifyRequestRetirement: [async ({}, use, testInfo) => {
    const firstContext = contexts.length;
    try { await use(); }
    finally {
      const ownedContexts = contexts.slice(firstContext);
      for (const context of ownedContexts) {
        await expect(context.get(process.env.FLASHWRIGHT_REQUEST_ORIGIN! + '/inspect')).rejects.toThrow(/disposed|closed/i);
      }
      await record({ phase: 'fixture-retired', title: testInfo.title, retry: testInfo.retry, contextCount: ownedContexts.length });
    }
  }, { auto: true }],
});
test.use({ actionTimeout: 0 });

const mode = process.env.FLASHWRIGHT_REQUEST_LIFECYCLE_MODE;
if (mode === 'throw') {
  test('original body failure retains request fixture cleanup', async ({ request }) => {
    expect((await request.get('/html')).status()).toBe(200);
    throw new Error('original-request-body-failure');
  });
} else if (mode === 'timeout') {
  test('pending HTTP retires when the owning test times out', async ({ request }) => {
    test.setTimeout(750);
    await record({ phase: 'body-pending' });
    await request.get('/never');
  });
} else if (mode === 'retry') {
  test('retry receives a fresh request jar', async ({ request }, testInfo) => {
    const details = await (await request.get('/inspect')).json() as { cookie: string };
    expect(details.cookie).toBe('seed=original');
    await record({ phase: 'retry-start', retry: testInfo.retry, cookie: details.cookie });
    if (testInfo.retry === 0) {
      await request.get('/set-cookie');
      throw new Error('intentional-request-retry');
    }
  });
} else {
  throw new Error('Choose a request lifecycle mode: throw, timeout, or retry');
}
