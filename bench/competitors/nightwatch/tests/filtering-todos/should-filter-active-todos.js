describe("Filtering Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-filter-active-todos", async function (browser) {
    await browser.setValue(".new-todo", ["Active 1", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Active 2", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Will complete", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Active 1']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Active 2']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Will complete']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.click({ selector: "//ul[@class='todo-list']/li[.//label[.='Will complete']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' });
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li[.//label[.='Will complete']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' }).to.be.selected;
    await browser.expect.element(".todo-count").text.to.equal("2 items left");
    await browser.click(".filters a[href=\"#/active\"]");
    await browser.expect.url().to.contain("#/active");
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Active 1']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Active 2']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Will complete']", locateStrategy: 'xpath' }).to.not.be.present;
    await browser.expect.element(".filters a[href=\"#/active\"]").to.be.visible;
  });
});
