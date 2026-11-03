import { By, Key, until } from 'selenium-webdriver';
import { TIMEOUT, countIs, createDriver, enabled, focused, hidden, selectedIs, textIs, textsAre, valueIs, visible, use } from '../support.mjs';

describe("Editing Todos", function () {
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

  it("should trim whitespace when editing", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Original task", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Original task']"));
    await driver.actions().doubleClick(await visible(By.css(".todo-list li label"))).perform();
    await (await visible(By.css(".todo-list li .edit"))).sendKeys(Key.chord(Key.CONTROL, 'a'), "   Edited task   ");
    await valueIs(By.css(".todo-list li .edit"), "   Edited task   ");
    await (await visible(By.css(".todo-list li .edit"))).sendKeys(Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Edited task']"));
  });
});
