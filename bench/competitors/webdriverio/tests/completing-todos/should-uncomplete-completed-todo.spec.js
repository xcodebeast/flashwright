import { browser, $, $$, expect } from '@wdio/globals';

describe("Completing Todos", () => {
  beforeEach(async () => {
    await browser.url(process.env.APP_URL);
  });

  it("should-uncomplete-completed-todo", async () => {
    await $(".new-todo").setValue("Buy groceries");
    await browser.keys('Enter');
    await $(".todo-list li .toggle").click();
    await $(".todo-list li .toggle").click();
  });
});
