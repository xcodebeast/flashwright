describe("Completing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-uncomplete-completed-todo", async function (browser) {
    await browser.setValue(".new-todo", ["Buy groceries", browser.Keys.ENTER]);
    await browser.click(".todo-list li .toggle");
    await browser.click(".todo-list li .toggle");
  });
});
