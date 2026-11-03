import { browser, $, $$, expect } from '@wdio/globals';

describe("Todo Creation", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("Add todo with special characters", async () => {
    await expect($(".new-todo")).toBeDisplayed();
    await $(".new-todo").setValue("Buy @groceries & supplies (urgent!)");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Buy @groceries & supplies (urgent!)']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("1 item left");
  });
});
