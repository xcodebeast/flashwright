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

  it("should edit todo by double-clicking", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Buy milk", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Buy milk']"));
    await driver.actions().doubleClick(await visible(By.css(".todo-list li label"))).perform();
    await visible(By.css(".todo-list li .edit"));
    await valueIs(By.css(".todo-list li .edit"), "Buy milk");
    await (await visible(By.css(".todo-list li .edit"))).sendKeys(Key.chord(Key.CONTROL, 'a'), "Buy organic milk");
    await (await visible(By.css(".todo-list li .edit"))).sendKeys(Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Buy organic milk']"));
  });
});
