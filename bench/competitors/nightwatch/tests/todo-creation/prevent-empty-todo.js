describe("Todo Creation", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("Prevent adding empty todo", async function (browser) {
    await browser.expect.element(".new-todo").to.be.visible;
    await browser.click(".new-todo");
    await browser.sendKeys(".new-todo", browser.Keys.ENTER);
    await browser.expect.elements(".todo-list li").count.to.equal(0);
    await browser.expect.element(".new-todo").to.have.value.that.equals("");
  });
});
