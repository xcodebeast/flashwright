describe("Adding Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should not add empty todo", async function (browser) {
    await browser.click(".new-todo");
    await browser.expect.element(".new-todo").to.be.active;
    await browser.sendKeys(".new-todo", browser.Keys.ENTER);
    await browser.expect.element(".todo-list").to.not.be.present;
  });
});
