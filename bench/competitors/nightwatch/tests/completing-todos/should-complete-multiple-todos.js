describe("Completing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should complete multiple todos", async function (browser) {
    await browser.setValue(".new-todo", ["Buy milk", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Walk dog", browser.Keys.ENTER]);
    await browser.setValue(".new-todo", ["Finish report", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Buy milk']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Walk dog']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Finish report']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("3 items left");
    await browser.click({ selector: "//ul[@class='todo-list']/li[.//label[.='Buy milk']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' });
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li[.//label[.='Buy milk']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' }).to.be.selected;
    await browser.expect.element(".todo-count").text.to.equal("2 items left");
    await browser.click({ selector: "//ul[@class='todo-list']/li[.//label[.='Finish report']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' });
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li[.//label[.='Finish report']]//input[contains(@class,'toggle')]", locateStrategy: 'xpath' }).to.be.selected;
    await browser.expect.element(".todo-count").text.to.equal("1 item left");
    await browser.expect.element(".clear-completed").to.be.visible;
  });
});
