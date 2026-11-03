describe("Completing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-toggle-all-todos-complete", async function (browser) {
    await browser.setValue(".new-todo", ["Task 1", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Task 2", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Task 3", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 1']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 2']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 3']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("3 items left");
    await browser.click("label[for=\"toggle-all\"]");
    await browser.expect.element(".todo-count").text.to.equal("0 items left");
    await browser.expect.element(".clear-completed").to.be.visible;
  });
});
