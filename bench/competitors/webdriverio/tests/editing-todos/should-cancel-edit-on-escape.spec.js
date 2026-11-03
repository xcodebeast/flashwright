import { browser, $, $$, expect } from '@wdio/globals';
import { Key } from 'webdriverio';

describe("Editing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should-cancel-edit-on-escape", async () => {
    await $(".new-todo").setValue("Original text");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Original text']")).toBeDisplayed();
    await $(".todo-list li label").doubleClick();
    await expect($(".todo-list li .edit")).toHaveValue("Original text");
    await browser.keys([Key.Ctrl, 'a']);
    await $(".todo-list li .edit").addValue("Modified text");
    await browser.keys("Escape");
    await expect($("//ul[@class='todo-list']/li//label[.='Original text']")).toBeDisplayed();
  });
});
