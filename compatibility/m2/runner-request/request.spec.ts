import { test, expect, request as runnerRequest, type APIRequestContext, type APIResponse } from '@flashwright/test';
import { request as libraryRequest } from 'flashwright';

type APIRequestContextOptions = NonNullable<Parameters<typeof runnerRequest.newContext>[0]>;
const origin = process.env.FLASHWRIGHT_REQUEST_ORIGIN!;
const originalNewContext = runnerRequest.newContext.bind(runnerRequest);
let createdContexts = 0;
let previousFixture: APIRequestContext | undefined;
let previousResponse: APIResponse | undefined;
runnerRequest.newContext = async options => {
  createdContexts++;
  return originalNewContext(options);
};

async function inspect(context: APIRequestContext, url = '/inspect') {
  const response = await context.get(url);
  expect(response.ok()).toBe(true);
  return await response.json() as { userAgent: string; cookie: string; path: string; query: Record<string, string> };
}

test('ordinary unused fixture is lazy and public factories have one identity', async () => {
  expect(createdContexts).toBe(0);
  expect(runnerRequest).toBe(libraryRequest);
});

test('native request fixture inherits file cookies and runner defaults', async ({ request }) => {
  expect(createdContexts).toBe(1);
  expect(await inspect(request)).toMatchObject({ userAgent: 'RequestFixture/1.0', cookie: 'seed=original', path: '/inspect' });
  previousFixture = request;
  previousResponse = await request.get('/html');
  expect(previousResponse.status()).toBe(200);
  expect(await previousResponse.text()).toBe('<p>Mail: blåbær ✓</p>');
});

test('success teardown disposes original context and response bodies', async ({ request }) => {
  expect(previousFixture).toBeDefined();
  await expect(previousFixture!.get(origin + '/inspect')).rejects.toThrow(/disposed|closed/i);
  expect(previousResponse!.status()).toBe(200);
  await expect(previousResponse!.body()).rejects.toThrow(/disposed|closed/i);
  expect(await inspect(request)).toMatchObject({ cookie: 'seed=original' });
});

test('manual public factory and numeric query use the same test defaults', async () => {
  const context = await libraryRequest.newContext();
  try {
    const response = await context.get('/inspect', { params: { query: 'to:user+mail@example.test', limit: 1 } });
    expect(await response.json()).toMatchObject({ userAgent: 'RequestFixture/1.0', cookie: 'seed=original', query: { query: 'to:user+mail@example.test', limit: '1' } });
    expect((await context.get(origin + '/html')).status()).toBe(200);
    const failure = await context.get('/missing');
    expect(failure.ok()).toBe(false);
    expect(failure.status()).toBe(404);
    expect(await failure.text()).toBe('No email');
  } finally { await context.dispose(); }
});

test('inherited properties do not override defaults after options are cloned', async () => {
  const options: APIRequestContextOptions = Object.create({ baseURL: 'http://invalid.example.test', userAgent: 'Inherited/2.0', storageState: { cookies: [], origins: [] } });
  const context = await runnerRequest.newContext(options);
  try { expect(await inspect(context)).toMatchObject({ userAgent: 'RequestFixture/1.0', cookie: 'seed=original' }); }
  finally { await context.dispose(); }
  expect(Object.keys(options)).toEqual([]);
});

test('own undefined clears inherited URL cookies and user agent without mutation', async () => {
  const options = { baseURL: undefined, userAgent: undefined, storageState: undefined };
  const context = await runnerRequest.newContext(options as unknown as APIRequestContextOptions);
  try {
    await expect(context.get('/inspect')).rejects.toThrow();
    const details = await inspect(context, origin + '/inspect');
    expect(details.cookie).toBe('');
    expect(details.userAgent).not.toBe('RequestFixture/1.0');
    expect(Object.keys(options)).toEqual(['baseURL', 'userAgent', 'storageState']);
    expect(Object.values(options)).toEqual([undefined, undefined, undefined]);
  } finally { await context.dispose(); }
});

test('explicit empty state and context options override shared defaults', async () => {
  const context = await runnerRequest.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, userAgent: 'ExplicitRequest/2.0' });
  try { expect(await inspect(context)).toMatchObject({ userAgent: 'ExplicitRequest/2.0', cookie: '' }); }
  finally { await context.dispose(); }
});

test('fixture cookies and manually owned jars remain independent', async ({ request }) => {
  await request.get('/set-cookie');
  expect((await inspect(request)).cookie).toContain('changed=fixture');
  const context = await runnerRequest.newContext();
  try { expect((await inspect(context)).cookie).toBe('seed=original'); }
  finally { await context.dispose(); }
});

test('next fixture has fresh cookies and duplicate explicit disposal is safe', async ({ request }) => {
  expect((await inspect(request)).cookie).toBe('seed=original');
  await Promise.all([request.dispose(), request.dispose()]);
  await expect(request.get('/inspect')).rejects.toThrow(/disposed|closed/i);
});

test('default finite timeout and per-call zero preserve their semantics', async ({ request }) => {
  await expect(request.get('/delay')).rejects.toThrow(/timeout|deadline/i);
  expect((await request.get('/delay', { timeout: 0 })).status()).toBe(200);
  const context = await runnerRequest.newContext({ timeout: 0 });
  try {
    expect((await context.get('/delay')).status()).toBe(200);
    await expect(context.get('/delay', { timeout: 20 })).rejects.toThrow(/timeout|deadline/i);
  } finally { await context.dispose(); }
});

test('undefined timeout inherits while malformed construction is classified', async () => {
  const context = await runnerRequest.newContext({ timeout: undefined } as unknown as APIRequestContextOptions);
  try { await expect(context.get('/delay')).rejects.toThrow(/timeout|deadline/i); }
  finally { await context.dispose(); }
  for (const timeout of [null, 'invalid']) {
    const malformedOptions = { timeout } as unknown as APIRequestContextOptions;
    if (process.env.FLASHWRIGHT_REQUEST_ENGINE === 'playwright') {
      let referenceContext: APIRequestContext | undefined;
      try {
        const construction = await runnerRequest.newContext(malformedOptions).then(created => {
          referenceContext = created;
          return { status: 'fulfilled' };
        }, error => ({ status: 'rejected', name: error.name, message: error.message }));
        test.info().annotations.push({ type: 'malformed-timeout-construction', description: JSON.stringify({ timeout, ...construction }) });
        if (referenceContext) expect(typeof referenceContext.get).toBe('function');
      } finally { await referenceContext?.dispose(); }
    } else {
      await expect(runnerRequest.newContext(malformedOptions)).rejects.toThrow(/timeout|number/i);
    }
  }
});

test.describe('unlimited runner default', () => {
  test.use({ actionTimeout: 0 });
  test('zero actionTimeout reaches fixture and manual factory', async ({ request }) => {
    expect((await request.get('/delay')).status()).toBe(200);
    const context = await runnerRequest.newContext();
    try { expect((await context.get('/delay')).status()).toBe(200); }
    finally { await context.dispose(); }
  });
});

test.describe('standalone hook custody', () => {
  let beforeAllFixture: APIRequestContext;
  let manuallyOwned: APIRequestContext;
  test.beforeAll(async ({ request }) => {
    expect(await inspect(request)).toMatchObject({ cookie: 'seed=original', userAgent: 'RequestFixture/1.0' });
    beforeAllFixture = request;
    manuallyOwned = await runnerRequest.newContext();
  });
  test('beforeAll fixture retires with its diagnostic and manual context survives', async ({ request }) => {
    await expect(beforeAllFixture.get('/inspect')).rejects.toThrow('Fixture { request } from beforeAll cannot be reused in a test.');
    expect(await inspect(manuallyOwned)).toMatchObject({ cookie: 'seed=original' });
    expect(await inspect(request)).toMatchObject({ cookie: 'seed=original' });
  });
  test.afterAll(async ({ request }) => {
    try {
      expect((await request.get('/html')).status()).toBe(200);
      expect((await manuallyOwned.get('/html')).status()).toBe(200);
    } finally { await manuallyOwned.dispose(); }
  });
});

const extended = test.extend<{ mailResponse: APIResponse }>({
  mailResponse: async ({ request }, use) => {
    const response = await request.get('/html');
    try { await use(response); } finally { await response.dispose(); }
  },
});
extended('typed custom fixture depends on native request fixture', async ({ mailResponse }) => {
  expect(await mailResponse.text()).toBe('<p>Mail: blåbær ✓</p>');
});
