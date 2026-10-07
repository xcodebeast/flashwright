import { test, expect } from './adapter.js';

const extended = test.extend<{ decorated: string }>({
  decorated: async ({ probe }, use) => { await use(`[${await probe.read()}]`); },
});

extended.use({ greeting: 'custom' });
extended.beforeEach(async ({ probe }) => { expect(await probe.read()).toContain('custom'); });

extended('preserves extended fixture dependency order and custom options', async ({ probe, decorated }, testInfo) => {
  expect(decorated).toMatch(/^\[custom:worker-\d+\]$/);
  await expect(probe).toHaveProbeValue(/^custom:/);
  await expect(probe).not.toHaveProbeValue(/^other:/);
  await testInfo.attach('boundary', { body: 'No upstream browser fixtures requested', contentType: 'text/plain' });
});

extended('supports configured expectations and runner steps', async ({ probe }) => {
  await extended.step('custom matcher step', async () => {
    await expect.configure({ timeout: 1000 })(probe).toHaveProbeValue(/^custom:/);
  });
});

extended('soft matcher failure reaches runner status', async ({ probe }, testInfo) => {
  extended.fail();
  await expect.soft(probe).toHaveProbeValue(/^impossible:/);
  expect(testInfo.errors).toHaveLength(1);
});

extended('uses runner retries', async ({}, testInfo) => {
  expect(testInfo.retry).toBe(1);
});

extended('runner timeout still tears down dependent fixtures', async ({ probe }) => {
  extended.setTimeout(50);
  expect(await probe.read()).toContain('custom');
  await new Promise(() => {});
});
