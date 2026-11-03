import { browser, $, $$, expect } from '@wdio/globals';
import { Key } from 'webdriverio';

describe("Editing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should trim whitespace when editing", async () => {
    await $(".new-todo").setValue("Original task");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Original task']")).toBeDisplayed();
    await $(".todo-list li label").doubleClick();
    await browser.keys([Key.Ctrl, 'a']);
    await $(".todo-list li .edit").addValue("   Edited task   ");
    await expect($(".todo-list li .edit")).toHaveValue("   Edited task   ", { trim: false });
    await browser.keys("Enter");
    await expect($("//ul[@class='todo-list']/li//label[.='Edited task']")).toBeDisplayed();
  });
});
