import { By, Key, until } from 'selenium-webdriver';
import { TIMEOUT, countIs, createDriver, enabled, focused, hidden, selectedIs, textIs, textsAre, valueIs, visible, use } from '../support.mjs';

describe("Deleting Todos", function () {
  let driver;

  before(async function () {
    driver = await createDriver();
    use(driver);
  });

  after(async function () {
    await driver?.quit();
  });

  beforeEach(async function () {
    await driver.get(process.env.APP_URL);
  });

  it("should-delete-single-todo", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Task to delete", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Task to delete']"));
    await textIs(By.css(".todo-count"), "1 item left");
    await driver.actions().move({ origin: await visible(By.css(".todo-list li")) }).perform();
    await visible(By.css(".todo-list li .destroy"));
    await (await visible(By.css(".todo-list li .destroy"))).click();
    await hidden(By.xpath("//ul[@class='todo-list']/li//label[.='Task to delete']"));
    await hidden(By.css(".todo-list li label"));
  });
});
