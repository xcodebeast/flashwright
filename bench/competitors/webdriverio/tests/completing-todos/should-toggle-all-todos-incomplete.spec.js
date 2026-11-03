import { browser, $, $$, expect } from '@wdio/globals';

describe("Completing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should toggle all todos incomplete", async () => {
    await $(".new-todo").setValue("First todo");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Second todo");
    await browser.keys('Enter');
    await $(".new-todo").setValue("Third todo");
    await browser.keys('Enter');
    await $("label[for=\"toggle-all\"]").click();
    await expect($(".todo-count")).toHaveText("0 items left");
    await $("label[for=\"toggle-all\"]").click();
    await expect($(".todo-count")).toHaveText("3 items left");
  });
});
