import { browser, $, $$, expect } from '@wdio/globals';
import { Key } from 'webdriverio';

describe("Editing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should edit todo by double-clicking", async () => {
    await $(".new-todo").setValue("Buy milk");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Buy milk']")).toBeDisplayed();
    await $(".todo-list li label").doubleClick();
    await expect($(".todo-list li .edit")).toBeDisplayed();
    await expect($(".todo-list li .edit")).toHaveValue("Buy milk");
    await browser.keys([Key.Ctrl, 'a']);
    await $(".todo-list li .edit").addValue("Buy organic milk");
    await browser.keys("Enter");
    await expect($("//ul[@class='todo-list']/li//label[.='Buy organic milk']")).toBeDisplayed();
  });
});
