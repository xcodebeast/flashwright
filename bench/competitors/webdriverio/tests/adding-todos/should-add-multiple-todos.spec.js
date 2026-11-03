import { browser, $, $$, expect } from '@wdio/globals';

describe("Adding Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should add multiple todos", async () => {
    await $(".new-todo").setValue("Buy milk");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Buy milk']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("1 item left");
    await $(".new-todo").setValue("Walk the dog");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Buy milk']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Walk the dog']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("2 items left");
    await $(".new-todo").setValue("Finish report");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Buy milk']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Walk the dog']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Finish report']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("3 items left");
  });
});
