import { browser, $, $$, expect } from '@wdio/globals';
import { Key } from 'webdriverio';

describe("Editing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should-save-edit-on-blur", async () => {
    await $(".new-todo").setValue("Call dentist");
    await browser.keys('Enter');
    await $(".todo-list li label").doubleClick();
    await browser.keys([Key.Ctrl, 'a']);
    await $(".todo-list li .edit").addValue("Schedule dentist appointment");
    await $(".header h1").click();
    await expect($("//ul[@class='todo-list']/li//label[.='Schedule dentist appointment']")).toBeDisplayed();
  });
});
