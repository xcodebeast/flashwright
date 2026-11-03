describe("Editing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-cancel-edit-on-escape", async function (browser) {
    await browser.setValue(".new-todo", ["Original text", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Original text']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.doubleClick(".todo-list li label");
    await browser.expect.element(".todo-list li .edit").to.have.value.that.equals("Original text");
    await browser.sendKeys(".todo-list li .edit", [browser.Keys.CONTROL, 'a', browser.Keys.NULL, "Modified text"]);
    await browser.sendKeys(".todo-list li .edit", browser.Keys.ESCAPE);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Original text']", locateStrategy: 'xpath' }).to.be.visible;
  });
});
