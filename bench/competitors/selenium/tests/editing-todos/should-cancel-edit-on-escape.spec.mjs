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

  it("should-cancel-edit-on-escape", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Original text", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Original text']"));
    await driver.actions().doubleClick(await visible(By.css(".todo-list li label"))).perform();
    await valueIs(By.css(".todo-list li .edit"), "Original text");
    await (await visible(By.css(".todo-list li .edit"))).sendKeys(Key.chord(Key.CONTROL, 'a'), "Modified text");
    await (await visible(By.css(".todo-list li .edit"))).sendKeys(Key.ESCAPE);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Original text']"));
  });
});
