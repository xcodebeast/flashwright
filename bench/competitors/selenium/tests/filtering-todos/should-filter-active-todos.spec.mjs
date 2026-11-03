import { By, Key, until } from 'selenium-webdriver';
import { TIMEOUT, countIs, createDriver, enabled, focused, hidden, selectedIs, textIs, textsAre, valueIs, visible, use } from '../support.mjs';

describe("Filtering Todos", function () {
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

  it("should-filter-active-todos", async function () {
    await (await visible(By.css(".new-todo"))).sendKeys("Active 1", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Active 2", Key.ENTER);
    await (await visible(By.css(".new-todo"))).sendKeys("Will complete", Key.ENTER);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Active 1']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Active 2']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Will complete']"));
    await (await enabled(By.xpath("//ul[@class='todo-list']/li[.//label[.='Will complete']]//input[contains(@class,'toggle')]"))).click();
    await selectedIs(By.xpath("//ul[@class='todo-list']/li[.//label[.='Will complete']]//input[contains(@class,'toggle')]"), true);
    await textIs(By.css(".todo-count"), "2 items left");
    await (await visible(By.css(".filters a[href=\"#/active\"]"))).click();
    await driver.wait(until.urlContains("#/active"), TIMEOUT);
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Active 1']"));
    await visible(By.xpath("//ul[@class='todo-list']/li//label[.='Active 2']"));
    await hidden(By.xpath("//ul[@class='todo-list']/li//label[.='Will complete']"));
    await visible(By.css(".filters a[href=\"#/active\"]"));
  });
});
