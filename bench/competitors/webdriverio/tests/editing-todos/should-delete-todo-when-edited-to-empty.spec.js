import { browser, $, $$, expect } from '@wdio/globals';
import { Key } from 'webdriverio';

describe("Editing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should delete todo when edited to empty", async () => {
    await $(".new-todo").setValue("Temporary task");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Temporary task']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("1 item left");
    await $(".todo-list li label").doubleClick();
    await expect($(".todo-list li .edit")).toBeDisplayed();
    await browser.keys([Key.Ctrl, 'a']);
    await browser.keys('Backspace');
    await browser.keys("Enter");
    await expect($("//ul[@class='todo-list']/li//label[.='Temporary task']")).not.toBeDisplayed();
    await expect($(".todo-list li label")).not.toBeDisplayed();
  });
});
