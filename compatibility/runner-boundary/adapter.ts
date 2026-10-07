import * as upstream from 'flashwright-upstream-runner/test';

// This probe must fail if any upstream browser command path is entered.
for (const browserType of [upstream.chromium, upstream.firefox, upstream.webkit]) {
  const forbidden = async () => { throw new Error('Runner boundary entered the forbidden upstream browser backend.'); };
  browserType.launch = forbidden;
  browserType.launchPersistentContext = forbidden;
  browserType.connect = forbidden;
  browserType.connectOverCDP = forbidden;
}
upstream.request.newContext = async () => { throw new Error('Runner boundary entered the forbidden upstream request backend.'); };

/** The single version-pinned private runner boundary; no browser objects are impersonated. */
const rootTest = upstream._baseTest;
if (!rootTest || typeof rootTest.extend !== 'function') {
  throw new Error('Playwright 1.60.0 root runner boundary is unavailable.');
}

export class Probe {
  constructor(readonly value: string) {}
  async read() { return this.value; }
}

export const test = rootTest.extend<{ probe: Probe; greeting: string }, { workerLabel: string }>({
  greeting: ['hello', { option: true }],
  workerLabel: [async ({}, use, workerInfo) => { await use(`worker-${workerInfo.workerIndex}`); }, { scope: 'worker' }],
  probe: async ({ greeting, workerLabel }, use, testInfo) => {
    const probe = new Probe(`${greeting}:${workerLabel}`);
    await use(probe);
    await testInfo.attach('probe-disposed', { body: 'disposed', contentType: 'text/plain' });
  },
});

export const expect = upstream.expect.extend({
  async toHaveProbeValue(actual: Probe, expected: RegExp) {
    const received = await actual.read();
    return { pass: expected.test(received), message: () => `Expected ${String(expected)}, received ${received}`, actual: received, expected };
  },
});
export const defineConfig = upstream.defineConfig;
