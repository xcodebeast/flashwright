describe("Editing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should delete todo when edited to empty", async function (browser) {
    await browser.setValue(".new-todo", ["Temporary task", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Temporary task']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("1 item left");
    await browser.doubleClick(".todo-list li label");
    await browser.expect.element(".todo-list li .edit").to.be.visible;
    await browser.sendKeys(".todo-list li .edit", [browser.Keys.CONTROL, 'a', browser.Keys.NULL, browser.Keys.BACK_SPACE]);
    await browser.sendKeys(".todo-list li .edit", browser.Keys.ENTER);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Temporary task']", locateStrategy: 'xpath' }).to.not.be.present;
    await browser.expect.element(".todo-list li label").to.not.be.present;
  });
});
