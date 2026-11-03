import { browser, $, $$, expect } from '@wdio/globals';

describe("Deleting Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should-delete-specific-todo-from-multiple", async () => {
    await $(".new-todo").setValue("Task 1");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Task 2");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Task 3");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Task 1']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Task 2']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Task 3']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("3 items left");
    await $("//ul[@class='todo-list']/li[.//label[.='Task 2']]").moveTo();
    await $("//ul[@class='todo-list']/li[.//label[.='Task 2']]").$('.destroy').click();
    await expect($("//ul[@class='todo-list']/li//label[.='Task 1']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Task 3']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("2 items left");
  });
});
