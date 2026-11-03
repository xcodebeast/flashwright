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

  it("should-uncomplete-completed-todo", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Buy groceries", Key.ENTER);
    await (await enabled(By.css(".todo-list li .toggle"))).click();
    await (await enabled(By.css(".todo-list li .toggle"))).click();
  });
});
