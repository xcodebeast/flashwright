import { By, Key, until } from 'selenium-webdriver';
import { TIMEOUT, countIs, createDriver, enabled, focused, hidden, selectedIs, textIs, textsAre, valueIs, visible, use } from '../support.mjs';

describe("Completing Todos", function () {
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

  it("should complete multiple todos", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Buy milk", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Walk dog", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Finish report", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Buy milk']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Walk dog']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Finish report']"));
    await textIs(By.css(".todo-count"), "3 items left");
    await (await enabled(By.xpath("//ul[@class='todo-list']/li[.//label[.='Buy milk']]//input[contains(@class,'toggle')]"))).click();
    await selectedIs(By.xpath("//ul[@class='todo-list']/li[.//label[.='Buy milk']]//input[contains(@class,'toggle')]"), true);
    await textIs(By.css(".todo-count"), "2 items left");
    await (await enabled(By.xpath("//ul[@class='todo-list']/li[.//label[.='Finish report']]//input[contains(@class,'toggle')]"))).click();
    await selectedIs(By.xpath("//ul[@class='todo-list']/li[.//label[.='Finish report']]//input[contains(@class,'toggle')]"), true);
    await textIs(By.css(".todo-count"), "1 item left");
    await visible(By.css(".clear-completed"));
  });
});
