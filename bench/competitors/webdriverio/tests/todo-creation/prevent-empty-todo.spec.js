import { browser, $, $$, expect } from '@wdio/globals';

describe("Todo Creation", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("Prevent adding empty todo", async () => {
    await expect($(".new-todo")).toBeDisplayed();
    await $(".new-todo").click();
    await browser.keys("Enter");
    await expect($$(".todo-list li")).toBeElementsArrayOfSize(0);
    await expect($(".new-todo")).toHaveValue("");
  });
});
