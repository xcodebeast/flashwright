import { browser, $, $$, expect } from '@wdio/globals';

describe("Deleting Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should-clear-all-completed-todos", async () => {
    await $(".new-todo").setValue("Task 1");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Task 2");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Task 3");
    await browser.keys('Enter');
    await expect($$(".todo-list li label")).toHaveText(["Task 1","Task 2","Task 3"]);
    await $("//ul[@class='todo-list']/li[.//label[.='Task 1']]").$('.toggle').click();
    await $("//ul[@class='todo-list']/li[.//label[.='Task 3']]").$('.toggle').click();
    await expect($(".todo-count")).toHaveText("1 item left");
    await expect($(".clear-completed")).toBeDisplayed();
    await $(".clear-completed").click();
    await expect($("//ul[@class='todo-list']/li//label[.='Task 2']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("1 item left");
  });
});
