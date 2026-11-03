describe("Deleting Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-clear-all-completed-todos", async function (browser) {
    await browser.setValue(".new-todo", ["Task 1", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Task 2", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Task 3", browser.Keys.ENTER]);
    await browser.expect.elements(".todo-list li").count.to.equal(3);
    await browser.expect.element(".todo-list li:nth-child(1) label").text.to.equal("Task 1");
    await browser.expect.element(".todo-list li:nth-child(2) label").text.to.equal("Task 2");
    await browser.expect.element(".todo-list li:nth-child(3) label").text.to.equal("Task 3");
    await browser.click({ selector: "//ul[@class='todo-list']/li[.//label[.='Task 1']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' });
    await browser.click({ selector: "//ul[@class='todo-list']/li[.//label[.='Task 3']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' });
    await browser.expect.element(".todo-count").text.to.equal("1 item left");
    await browser.expect.element(".clear-completed").to.be.visible;
    await browser.click(".clear-completed");
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 2']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("1 item left");
  });
});
