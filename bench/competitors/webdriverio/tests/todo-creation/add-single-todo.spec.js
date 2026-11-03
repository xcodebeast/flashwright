import { browser, $, $$, expect } from '@wdio/globals';

describe("Todo Creation", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("Add a single todo", async () => {
    await expect($(".new-todo")).toBeDisplayed();
    await $(".new-todo").setValue("Buy groceries");
    await expect($(".new-todo")).toHaveValue("Buy groceries");
    await browser.keys("Enter");
    await expect($("//ul[@class='todo-list']/li//label[.='Buy groceries']")).toBeDisplayed();
    await expect($(".new-todo")).toHaveValue("");
    await expect($(".todo-count")).toHaveText("1 item left");
    await expect($(".todo-list li .toggle")).not.toBeSelected();
  });
});
