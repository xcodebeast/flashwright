describe("Editing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-save-edit-on-blur", async function (browser) {
    await browser.setValue(".new-todo", ["Call dentist", browser.Keys.ENTER]);
    await browser.doubleClick(".todo-list li label");
    await browser.sendKeys(".todo-list li .edit", [browser.Keys.CONTROL, 'a', browser.Keys.NULL, "Schedule dentist appointment"]);
    await browser.click(".header h1");
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Schedule dentist appointment']", locateStrategy: 'xpath' }).to.be.visible;
  });
});
