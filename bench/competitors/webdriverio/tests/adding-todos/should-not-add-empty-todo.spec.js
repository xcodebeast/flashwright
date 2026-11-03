import { browser, $, $$, expect } from '@wdio/globals';

describe("Adding Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should not add empty todo", async () => {
    await $(".new-todo").click();
    await expect($(".new-todo")).toBeFocused();
    await browser.keys("Enter");
    await expect($(".todo-list")).not.toBeDisplayed();
  });
});
