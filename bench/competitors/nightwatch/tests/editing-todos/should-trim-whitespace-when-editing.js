describe("Editing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should trim whitespace when editing", async function (browser) {
    await browser.setValue(".new-todo", ["Original task", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Original task']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.doubleClick(".todo-list li label");
    await browser.sendKeys(".todo-list li .edit", [browser.Keys.CONTROL, 'a', browser.Keys.NULL, "   Edited task   "]);
    await browser.expect.element(".todo-list li .edit").to.have.value.that.equals("   Edited task   ");
    await browser.sendKeys(".todo-list li .edit", browser.Keys.ENTER);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Edited task']", locateStrategy: 'xpath' }).to.be.visible;
  });
});
