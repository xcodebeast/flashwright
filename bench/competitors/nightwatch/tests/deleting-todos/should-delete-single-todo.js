describe("Deleting Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-delete-single-todo", async function (browser) {
    await browser.setValue(".new-todo", ["Task to delete", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task to delete']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("1 item left");
    await browser.moveToElement(".todo-list li", 10, 10);
    await browser.expect.element(".todo-list li .destroy").to.be.visible;
    await browser.click(".todo-list li .destroy");
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Task to delete']", locateStrategy: 'xpath' }).to.not.be.present;
    await browser.expect.element(".todo-list li label").to.not.be.present;
  });
});
