import { browser, $, $$, expect } from '@wdio/globals';

describe("Completing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should complete multiple todos", async () => {
    await $(".new-todo").setValue("Buy milk");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Walk dog");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Finish report");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Buy milk']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Walk dog']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Finish report']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("3 items left");
    await $("//ul[@class='todo-list']/li[.//label[.='Buy milk']]").$('.toggle').click();
    await expect($("//ul[@class='todo-list']/li[.//label[.='Buy milk']]").$('.toggle')).toBeSelected();
    await expect($(".todo-count")).toHaveText("2 items left");
    await $("//ul[@class='todo-list']/li[.//label[.='Finish report']]").$('.toggle').click();
    await expect($("//ul[@class='todo-list']/li[.//label[.='Finish report']]").$('.toggle')).toBeSelected();
    await expect($(".todo-count")).toHaveText("1 item left");
    await expect($(".clear-completed")).toBeDisplayed();
  });
});
