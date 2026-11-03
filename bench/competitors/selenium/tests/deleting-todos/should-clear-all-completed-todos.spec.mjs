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

  it("should-clear-all-completed-todos", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Task 1", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Task 2", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Task 3", Key.ENTER);
    await textsAre(By.css(".todo-list li label"), ["Task 1","Task 2","Task 3"]);
    await (await enabled(By.xpath("//ul[@class='todo-list']/li[.//label[.='Task 1']]//input[contains(@class,'toggle')]"))).click();
    await (await enabled(By.xpath("//ul[@class='todo-list']/li[.//label[.='Task 3']]//input[contains(@class,'toggle')]"))).click();
    await textIs(By.css(".todo-count"), "1 item left");
    await visible(By.css(".clear-completed"));
    await (await visible(By.css(".clear-completed"))).click();
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Task 2']"));
    await textIs(By.css(".todo-count"), "1 item left");
  });
});
