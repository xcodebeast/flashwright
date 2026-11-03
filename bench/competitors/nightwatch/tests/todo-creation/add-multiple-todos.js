describe("Todo Creation", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("Add multiple todos", async function (browser) {
    await browser.expect.element(".new-todo").to.be.visible;
    await browser.setValue(".new-todo", ["Buy groceries", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Buy groceries']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.setValue(".new-todo", ["Walk the dog", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Walk the dog']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.setValue(".new-todo", ["Read a book", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Read a book']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Buy groceries']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Walk the dog']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Read a book']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("3 items left");
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li[.//label[.='Buy groceries']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' }).to.not.be.selected;
  });
});
