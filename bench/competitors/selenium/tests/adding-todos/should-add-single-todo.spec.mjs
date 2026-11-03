import { By, Key, until } from 'selenium-webdriver';
import { TIMEOUT, countIs, createDriver, enabled, focused, hidden, selectedIs, textIs, textsAre, valueIs, visible, use } from '../support.mjs';

describe("Adding Todos", function () {
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

  it("should add single todo", async function () {
    await visible(By.css(".new-todo"));
    await (await visible(By.css(".new-todo"))).clear();
    await (await visible(By.css(".new-todo"))).sendKeys("Buy groceries");
    await valueIs(By.css(".new-todo"), "Buy groceries");
    await (await visible(By.css(".new-todo"))).sendKeys(Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Buy groceries']"));
    await valueIs(By.css(".new-todo"), "");
    await textIs(By.css(".todo-count"), "1 item left");
  });
});
