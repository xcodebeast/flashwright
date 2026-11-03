import { browser, $, $$, expect } from '@wdio/globals';

describe("Deleting Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should-delete-single-todo", async () => {
    await $(".new-todo").setValue("Task to delete");
    await browser.keys('Enter');
    await expect($("//ul[@class='todo-list']/li//label[.='Task to delete']")).toBeDisplayed();
    await expect($(".todo-count")).toHaveText("1 item left");
    await $(".todo-list li").moveTo();
    await expect($(".todo-list li").$('.destroy')).toBeDisplayed();
    await $(".todo-list li").$('.destroy').click();
    await expect($("//ul[@class='todo-list']/li//label[.='Task to delete']")).not.toBeDisplayed();
    await expect($(".todo-list li label")).not.toBeDisplayed();
  });
});
