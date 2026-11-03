describe("Deleting Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-delete-specific-todo-from-multiple", async function (browser) {
    await browser.setValue(".new-todo", ["Task 1", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Task 2", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Task 3", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 1']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 2']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 3']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("3 items left");
    await browser.moveToElement({ selector: "//ul[@class='todo-list']/li[.//label[.='Task 2']]", locateStrategy: 'xpath' }, 10, 10);
    await browser.click({ selector: "//ul[@class='todo-list']/li[.//label[.='Task 2']]//button[@class='destroy']", locateStrategy: 'xpath' });
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 1']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task 3']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("2 items left");
  });
});
