describe("Editing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should edit todo by double-clicking", async function (browser) {
    await browser.setValue(".new-todo", ["Buy milk", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Buy milk']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.doubleClick(".todo-list li label");
    await browser.expect.element(".todo-list li .edit").to.be.visible;
    await browser.expect.element(".todo-list li .edit").to.have.value.that.equals("Buy milk");
    await browser.sendKeys(".todo-list li .edit", [browser.Keys.CONTROL, 'a', browser.Keys.NULL, "Buy organic milk"]);
    await browser.sendKeys(".todo-list li .edit", browser.Keys.ENTER);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Buy organic milk']", locateStrategy: 'xpath' }).to.be.visible;
  });
});
