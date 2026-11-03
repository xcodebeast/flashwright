import { browser, $, $$, expect } from '@wdio/globals';

describe("Todo Creation", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("Prevent adding whitespace-only todo", async () => {
    await expect($(".new-todo")).toBeDisplayed();
    await $(".new-todo").setValue("   ");
    await browser.keys('Enter');
    await expect($$(".todo-list li")).toBeElementsArrayOfSize(0);
  });
});
