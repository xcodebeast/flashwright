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

  it("Add todo with special characters", async function () {
    await visible(By.css(".new-todo"));
    await (await visible(By.css(".new-todo"))).sendKeys("Buy @groceries & supplies (urgent!)", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Buy @groceries & supplies (urgent!)']"));
    await textIs(By.css(".todo-count"), "1 item left");
  });
});
