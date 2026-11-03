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

  it("should delete todo when edited to empty", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Temporary task", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Temporary task']"));
    await textIs(By.css(".todo-count"), "1 item left");
    await driver.actions().doubleClick(await visible(By.css(".todo-list li label"))).perform();
    await visible(By.css(".todo-list li .edit"));
    await (await visible(By.css(".todo-list li .edit"))).sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE);
    await (await visible(By.css(".todo-list li .edit"))).sendKeys(Key.ENTER);
    await hidden(By.xpath("//ul[@class='todo-list']/li//label[.='Temporary task']"));
    await hidden(By.css(".todo-list li label"));
  });
});
