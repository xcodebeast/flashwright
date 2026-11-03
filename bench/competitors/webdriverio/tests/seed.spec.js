import { browser, $, $$, expect } from '@wdio/globals';

describe("Seed", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("seed", async () => {
  });
});
