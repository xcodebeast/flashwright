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

  it("should toggle all todos incomplete", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("First todo", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Second todo", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Third todo", Key.ENTER);
    await (await visible(By.css("label[for=\"toggle-all\"]"))).click();
    await textIs(By.css(".todo-count"), "0 items left");
    await (await visible(By.css("label[for=\"toggle-all\"]"))).click();
    await textIs(By.css(".todo-count"), "3 items left");
  });
});
