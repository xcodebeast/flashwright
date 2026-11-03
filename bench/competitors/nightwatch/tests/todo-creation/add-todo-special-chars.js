describe("Todo Creation", function () {
  beforeEach(function (browser) {
    browser.navigateTo(process.env.APP_URL);
  });

  after(function (browser) {
    browser.end();
  });

  it("Add todo with special characters", async function (browser) {
    await browser.expect.element(".new-todo").to.be.visible;
    await browser.setValue(".new-todo", ["Buy @groceries & supplies (urgent!)", browser.Keys.ENTER]);
    await browser.expect.element({ selector: "//ul[@class='todo-list']/li//label[.='Buy @groceries & supplies (urgent!)']", locateStrategy: 'xpath' }).to.be.visible;
    await browser.expect.element(".todo-count").text.to.equal("1 item left");
  });
});
