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

  it("should-delete-specific-todo-from-multiple", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Task 1", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Task 2", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Task 3", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Task 1']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Task 2']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Task 3']"));
    await textIs(By.css(".todo-count"), "3 items left");
    await driver.actions().move({ origin: await visible(By.xpath("//ul[@class='todo-list']/li[.//label[.='Task 2']]")) }).perform();
    await (await visible(By.xpath("//ul[@class='todo-list']/li[.//label[.='Task 2']]//button[@class='destroy']"))).click();
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Task 1']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Task 3']"));
    await textIs(By.css(".todo-count"), "2 items left");
  });
});
