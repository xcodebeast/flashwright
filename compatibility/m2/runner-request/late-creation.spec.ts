import { appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test as base, expect, request as requestFactory, type APIRequestContext } from '@flashwright/test';

if (process.env.FLASHWRIGHT_REQUEST_ENGINE !== 'flashwright') throw new Error('Delayed native publication gate is Flashwright-only');
const timeoutTitle = 'native request creation cannot escape its setup timeout';
const successorTitle = 'successor uses a fresh native request after original retirement';
const nativeOwners = new Map<string, string>();
type NativeClientDispatch = { request(method: string, ...arguments_: unknown[]): Promise<unknown> };
// This native-only fault boundary delays host publication after the real driver
// has allocated a request context. HTTP and request payload handling are unchanged.
const require = createRequire(import.meta.url);
const { EngineClient } = require(join(dirname(createRequire(require.resolve('flashwright')).resolve('@flashwright/core')), 'client.js')) as {
  EngineClient: { prototype: NativeClientDispatch };
};
const originalDispatch = EngineClient.prototype.request;
EngineClient.prototype.request = async function (this: NativeClientDispatch, method, ...arguments_) {
  const originalOwner = method === 'apiRequest.newContext' ? base.info().title : undefined;
  const result = await originalDispatch.call(this, method, ...arguments_);
  if (method === 'apiRequest.newContext') {
    if (!result || typeof result !== 'object' || !('identifier' in result) || typeof result.identifier !== 'string') throw new Error('Native request context omitted identifier');
    nativeOwners.set(result.identifier, originalOwner!);
    await record({ phase: 'native-allocation', context: result.identifier, owner: originalOwner });
    if (originalOwner === timeoutTitle) {
      await record({ phase: 'native-allocation-paused', context: result.identifier, owner: originalOwner });
      await new Promise(resolve => setTimeout(resolve, 1500));
      await record({ phase: 'native-publication-released', context: result.identifier, owner: originalOwner });
    }
  } else if (method === 'apiRequest.dispose') {
    const parameters = arguments_[0];
    if (!parameters || typeof parameters !== 'object' || !('context' in parameters) || typeof parameters.context !== 'string') throw new Error('Native request disposal omitted context');
    await record({ phase: 'native-disposal-complete', context: parameters.context, owner: nativeOwners.get(parameters.context) });
  }
  return result;
};

const originalNewContext = requestFactory.newContext.bind(requestFactory);
const pendingCreations = new Set<Promise<APIRequestContext>>();
const createdContexts: APIRequestContext[] = [];
requestFactory.newContext = options => {
  const creation = originalNewContext(options).then(context => {
    createdContexts.push(context);
    return context;
  });
  pendingCreations.add(creation);
  void creation.then(() => pendingCreations.delete(creation), () => pendingCreations.delete(creation));
  return creation;
};

async function record(event: object) {
  await appendFile(process.env.FLASHWRIGHT_REQUEST_LIFECYCLE_LOG!, JSON.stringify({ ...event, workerProcess: process.pid }) + '\n');
}

const test = base.extend<{ observeLateCreation: void }>({
  observeLateCreation: [async ({}, use, testInfo) => {
    const firstContext = createdContexts.length;
    try { await use(); }
    finally {
      await record({ phase: 'observer-teardown', owner: testInfo.title, pendingCreations: pendingCreations.size });
      await Promise.allSettled([...pendingCreations]);
      await new Promise(resolve => setImmediate(resolve));
      const ownedContexts = createdContexts.slice(firstContext);
      for (const context of ownedContexts) {
        await expect(context.get(process.env.FLASHWRIGHT_REQUEST_ORIGIN! + '/inspect')).rejects.toThrow(/disposed|closed/i);
      }
      await record({ phase: 'late-creation-retired', owner: testInfo.title, createdContexts: ownedContexts.length });
    }
  }, { auto: true, timeout: 5000 }],
});
test.use({ actionTimeout: 0 });
test.setTimeout(500);
test(timeoutTitle, async ({ request }) => {
  await record({ phase: 'unexpected-body' });
  await request.get('/inspect');
  throw new Error('Setup timeout must prevent the test body from running');
});
test.describe('successor scope', () => {
  test.setTimeout(15000);
  test(successorTitle, async ({ request }) => {
    await record({ phase: 'successor-operation' });
    const response = await request.get('/inspect');
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ cookie: 'seed=original', userAgent: 'RequestFixture/1.0' });
    await record({ phase: 'successor-complete' });
  });
});
