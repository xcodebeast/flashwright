import { By, Key, until } from 'selenium-webdriver';
import { TIMEOUT, countIs, createDriver, enabled, focused, hidden, selectedIs, textIs, textsAre, valueIs, visible, use } from '../support.mjs';

describe("Todo Creation", function () {
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

  it("Add multiple todos", async function () {
    await visible(By.css(".new-todo"));
    await (await visible(By.css(".new-todo"))).sendKeys("Buy groceries", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Buy groceries']"));
    await (await visible(By.css(".new-todo"))).sendKeys("Walk the dog", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Walk the dog']"));
    await (await visible(By.css(".new-todo"))).sendKeys("Read a book", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Read a book']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Buy groceries']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Walk the dog']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Read a book']"));
    await textIs(By.css(".todo-count"), "3 items left");
    await selectedIs(By.xpath("//ul[@class='todo-list']/li[.//label[.='Buy groceries']]//input[contains(@class,'toggle')]"), false);
  });
});
