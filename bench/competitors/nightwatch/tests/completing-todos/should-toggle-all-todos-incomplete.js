describe("Completing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should toggle all todos incomplete", async function (browser) {
    await browser.setValue(".new-todo", ["First todo", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Second todo", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Third todo", browser.Keys.ENTER]);
    await browser.click("label[for=\"toggle-all\"]");
    await browser.expect.element(".todo-count").text.to.equal("0 items left");
    await browser.click("label[for=\"toggle-all\"]");
    await browser.expect.element(".todo-count").text.to.equal("3 items left");
  });
});
