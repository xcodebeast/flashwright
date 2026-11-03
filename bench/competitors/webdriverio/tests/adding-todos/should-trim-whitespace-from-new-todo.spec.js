import { browser, $, $$, expect } from '@wdio/globals';

describe("Adding Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should trim whitespace from new todo", async () => {
    await $(".new-todo").setValue("   Todo with spaces   ");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Todo with spaces']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("1 item left");
  });
});
