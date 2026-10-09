import { test as base, expect } from '@flashwright/test';
import { chromium, type Browser, type Page } from 'flashwright';

// Actual Budget wraps the worker browser while tests create their own pages.
const test = base.extend<object, { browser: Browser }>({
  browser: [async ({ browser }, use) => {
    const original = browser.newPage.bind(browser);
    browser.newPage = async options => {
      const page = await original(options);
      await page.addInitScript(() => { (globalThis as any).workerInitScript = true; });
      return page;
    };
    try { await use(browser); } finally { browser.newPage = original; }
  }, { scope: 'worker' }],
});

async function inherited(page: Page, userAgent = 'RunnerContext/1.0') {
  await page.goto('/normal');
  expect(page.viewportSize()).toEqual({ width: 360, height: 240 });
  expect(await page.evaluate(() => ({ agent: navigator.userAgent, ratio: devicePixelRatio, touch: navigator.maxTouchPoints, cookie: document.cookie }))).toEqual({ agent: userAgent, ratio: 2, touch: 1, cookie: 'runner-cookie=inherited' });
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try { await inherited(page); } finally { await page.close(); }
});
test.afterAll(async ({ browser }) => {
  const context = await browser.newContext();
  try { await inherited(await context.newPage()); } finally { await context.close(); }
});

test('manual newContext inherits config and seeded cookies', async ({ browser }) => {
  const context = await browser.newContext();
  try { await inherited(await context.newPage()); } finally { await context.close(); }
});

test('manual newPage preserves worker wrapper and initial script', async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await inherited(page);
    expect(await page.evaluate(() => (globalThis as any).workerInitScript)).toBe(true);
  } finally { await page.close(); }
});

test('separately launched browser inside test inherits current runner scope', async () => {
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! });
  try { await inherited(await browser.newPage()); } finally { await browser.close(); }
});

test('explicit context options preserve false one and null with valid combinations', async ({ browser }) => {
  const page = await browser.newPage({ userAgent: 'Explicit/2.0', deviceScaleFactor: 1, isMobile: false, hasTouch: false, viewport: { width: 500, height: 300 }, storageState: { cookies: [], origins: [] } });
  try {
    await page.goto('/explicit');
    expect(page.viewportSize()).toEqual({ width: 500, height: 300 });
    expect(await page.evaluate(() => ({ agent: navigator.userAgent, ratio: devicePixelRatio, touch: navigator.maxTouchPoints, cookie: document.cookie }))).toEqual({ agent: 'Explicit/2.0', ratio: 1, touch: 0, cookie: '' });
  } finally { await page.close(); }
  await expect(browser.newContext({ viewport: null })).rejects.toThrow();
  const natural = await browser.newPage({ viewport: null, deviceScaleFactor: undefined, isMobile: false } as any);
  try { expect(natural.viewportSize()).toBe(null); } finally { await natural.close(); }
});

test('explicit undefined suppresses inherited options without mutating input', async ({ browser }) => {
  const options = { userAgent: undefined, viewport: undefined, deviceScaleFactor: undefined, hasTouch: undefined, isMobile: undefined, storageState: undefined, baseURL: undefined };
  const context = await browser.newContext(options as any);
  try {
    const page = await context.newPage();
    await expect(page.goto('/no-base')).rejects.toThrow();
    await page.goto(process.env.FLASHWRIGHT_DEFAULTS_ORIGIN! + '/absolute');
    expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
    expect(await page.evaluate(() => ({ ratio: devicePixelRatio, touch: navigator.maxTouchPoints, cookie: document.cookie }))).toEqual({ ratio: 1, touch: 0, cookie: '' });
    expect(await page.evaluate(() => navigator.userAgent)).not.toBe('RunnerContext/1.0');
    expect(Object.values(options).every(value => value === undefined)).toBe(true);
  } finally { await context.close(); }
});

test('action and navigation defaults apply to manual context', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/timeouts');
    await expect(page.getByText('never-created').click()).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(page.goto('/never-finishes')).rejects.toMatchObject({ name: 'TimeoutError' });
    context.setDefaultTimeout(1500);
    await page.goto('/override');
    await page.evaluate(() => { setTimeout(() => { const button = document.createElement('button'); button.textContent = 'delayed'; document.body.appendChild(button); }, 250); });
    await page.getByText('delayed').click();
  } finally { await context.close(); }
});

test.describe('per-test override scope', () => {
  test.use({ userAgent: 'PerTest/3.0' });
  test.beforeEach(async ({ browser }) => {
    const page = await browser.newPage();
    try { await inherited(page, 'PerTest/3.0'); } finally { await page.close(); }
  });
  test.afterEach(async ({ browser }) => {
    const page = await browser.newPage();
    try { await inherited(page, 'PerTest/3.0'); } finally { await page.close(); }
  });
  test('custom option applies in body and surrounding hooks', async ({ browser }) => {
    const context = await browser.newContext();
    try { await inherited(await context.newPage(), 'PerTest/3.0'); } finally { await context.close(); }
  });
});

test('next test restores original options in same worker', async ({ browser }) => {
  const page = await browser.newPage();
  try { await inherited(page); } finally { await page.close(); }
});
