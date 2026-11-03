import { browser, $, $$, expect } from '@wdio/globals';

describe("Completing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should-complete-single-todo", async () => {
    await $(".new-todo").setValue("Buy groceries");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Buy groceries']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("1 item left");
    await $(".todo-list li .toggle").click();
    await expect($(".todo-list li .toggle")).toBeSelected();
    await expect($(".todo-count")).toHaveText("0 items left");
    await expect($(".clear-completed")).toBeDisplayed();
  });
});
