describe("Adding Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should add single todo", async function (browser) {
    await browser.expect.element(".new-todo").to.be.visible;
    await browser.setValue(".new-todo", "Buy groceries");
    await browser.expect.element(".new-todo").to.have.value.that.equals("Buy groceries");
    await browser.sendKeys(".new-todo", browser.Keys.ENTER);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Buy groceries']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".new-todo").to.have.value.that.equals("");
    await browser.expect.element(".todo-count").text.to.equal("1 item left");
  });
});
