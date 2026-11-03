import { browser, $, $$, expect } from '@wdio/globals';

describe("Filtering Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should-filter-active-todos", async () => {
    await $(".new-todo").setValue("Active 1");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Active 2");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Will complete");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Active 1']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Active 2']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Will complete']")).toBeDisplayed();
    await $("//ul[@class='todo-list']/li[.//label[.='Will complete']]").$('.toggle').click();
    await expect($("//ul[@class='todo-list']/li[.//label[.='Will complete']]").$('.toggle')).toBeSelected();
    await expect($(".todo-count")).toHaveText("2 items left");
    await $(".filters a[href=\"#/active\"]").click();
    await expect(browser).toHaveUrl("#/active", { containing: true });
    await expect($("//ul[@class='todo-list']/li//label[.='Active 1']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Active 2']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Will complete']")).not.toBeDisplayed();
    await expect($(".filters a[href=\"#/active\"]")).toBeDisplayed();
  });
});
