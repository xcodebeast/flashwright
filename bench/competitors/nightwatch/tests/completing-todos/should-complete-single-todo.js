describe("Completing Todos", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("should-complete-single-todo", async function (browser) {
    await browser.setValue(".new-todo", ["Buy groceries", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Buy groceries']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("1 item left");
    await browser.click(".todo-list li .toggle");
    await browser.expect.element(".todo-list li .toggle").to.be.selected;
    await browser.expect.element(".todo-count").text.to.equal("0 items left");
    await browser.expect.element(".clear-completed").to.be.visible;
  });
});
