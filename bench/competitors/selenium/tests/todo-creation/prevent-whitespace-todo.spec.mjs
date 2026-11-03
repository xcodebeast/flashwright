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

  it("Prevent adding whitespace-only todo", async function () {
    await visible(By.css(".new-todo"));
    await (await visible(By.css(".new-todo"))).sendKeys("   ", Key.ENTER);
    await countIs(By.css(".todo-list li"), 0);
  });
});
