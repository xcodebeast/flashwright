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

  it("should trim whitespace from new todo", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("   Todo with spaces   ", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Todo with spaces']"));
    await textIs(By.css(".todo-count"), "1 item left");
  });
});
