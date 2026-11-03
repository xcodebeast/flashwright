import { browser, $, $$, expect } from '@wdio/globals';

describe("Todo Creation", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("Add multiple todos", async () => {
    await expect($(".new-todo")).toBeDisplayed();
    await $(".new-todo").setValue("Buy groceries");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Buy groceries']")).toBeDisplayed();
    await $(".new-todo").setValue("Walk the dog");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Walk the dog']")).toBeDisplayed();
    await $(".new-todo").setValue("Read a book");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Read a book']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Buy groceries']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Walk the dog']")).toBeDisplayed();
    await expect($("//ul[@class='todo-list']/li//label[.='Read a book']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("3 items left");
    await expect($("//ul[@class='todo-list']/li[.//label[.='Buy groceries']]").$('.toggle')).not.toBeSelected();
  });
});
