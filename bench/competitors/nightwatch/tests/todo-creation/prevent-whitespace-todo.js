describe("Todo Creation", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("Prevent adding whitespace-only todo", async function (browser) {
    await browser.expect.element(".new-todo").to.be.visible;
    await browser.setValue(".new-todo", ["   ", browser.Keys.ENTER]);
    await browser.expect.elements(".todo-list li").count.to.equal(0);
  });
});
