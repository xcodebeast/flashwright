import { request as libraryRequest, type APIRequest, type APIRequestContext, type APIRequestContextOptions, type APIRequestOptions, type APIResponse, type APIRequestHeader, type APIRequestFilePayload } from 'flashwright';
import { test, request as runnerRequest, type APIRequestContext as RunnerRequestContext } from '@flashwright/test';
import type { APIRequestContext as PlaywrightRequestContext } from '@playwright/test';

const canonicalFactory: APIRequest = libraryRequest;
const runnerFactory: APIRequest = runnerRequest;
const contextOptions: APIRequestContextOptions = { timeout: 0, storageState: { cookies: [], origins: [] } };
const requestOptions: APIRequestOptions = { params: { query: 'to:reader@example.test', limit: 1 } };
const filePayload: APIRequestFilePayload = { name: 'message.html', mimeType: 'text/html', buffer: Buffer.from('mail') };

async function responseTypes(response: APIResponse): Promise<APIRequestHeader[]> {
  await response.json();
  await response.text();
  await response.body();
  return response.headersArray();
}

// Unchanged application helpers keep their original upstream context annotation.
async function unchangedHelper(context: PlaywrightRequestContext) {
  const response = await context.get('/api/v1/search', requestOptions);
  return await response.json();
}

async function nativeFactoryTypes() {
  const context: APIRequestContext = await canonicalFactory.newContext(contextOptions);
  const runnerContext: RunnerRequestContext = await runnerFactory.newContext(contextOptions);
  try {
    await unchangedHelper(context);
    await responseTypes(await runnerContext.get('/html'));
    await context.post('/files', { multipart: { file: filePayload } });
  } finally { await Promise.all([context.dispose(), runnerContext.dispose()]); }
}

const extended = test.extend<{ nativeRequest: APIRequestContext }>({
  nativeRequest: async ({ request }, use) => { await use(request); },
});
extended('public native request fixture declaration', async ({ request, nativeRequest }) => {
  await unchangedHelper(request);
  await unchangedHelper(nativeRequest);
});
void nativeFactoryTypes;
