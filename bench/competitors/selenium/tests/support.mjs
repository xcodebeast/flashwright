import { Builder, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

export const TIMEOUT = 5000;
let driver;

export async function createDriver() {
  const options = new chrome.Options()
    .setChromeBinaryPath(process.env.CHROME_PATH)
    .addArguments('--headless=new', '--window-size=1280,720');
  return new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .setChromeService(new chrome.ServiceBuilder(process.env.CHROMEDRIVER_PATH))
    .build();
}

export function use(current) {
  driver = current;
}

// A condition that is retried while the element is missing or was re-rendered.
const retrying = condition => async () => {
  try {
    return await condition();
  } catch (error) {
    if (error.name === 'NoSuchElementError' || error.name === 'StaleElementReferenceError')
      return false;
    throw error;
  }
};

export async function visible(locator) {
  const element = await driver.wait(until.elementLocated(locator), TIMEOUT);
  await driver.wait(until.elementIsVisible(element), TIMEOUT);
  return element;
}

export async function enabled(locator) {
  const element = await driver.wait(until.elementLocated(locator), TIMEOUT);
  await driver.wait(until.elementIsEnabled(element), TIMEOUT);
  return element;
}

export async function hidden(locator) {
  await driver.wait(retrying(async () => {
    for (const element of await driver.findElements(locator)) {
      if (await element.isDisplayed())
        return false;
    }
    return true;
  }), TIMEOUT);
}

export async function textIs(locator, text) {
  await driver.wait(retrying(async () => await driver.findElement(locator).getText() === text), TIMEOUT);
}

export async function textsAre(locator, texts) {
  await driver.wait(retrying(async () => {
    const actual = await Promise.all((await driver.findElements(locator)).map(element => element.getText()));
    return JSON.stringify(actual) === JSON.stringify(texts);
  }), TIMEOUT);
}

export async function valueIs(locator, value) {
  await driver.wait(retrying(async () => await driver.findElement(locator).getAttribute('value') === value), TIMEOUT);
}

export async function selectedIs(locator, selected) {
  await driver.wait(retrying(async () => await driver.findElement(locator).isSelected() === selected), TIMEOUT);
}

export async function focused(locator) {
  await driver.wait(retrying(async () => await (await driver.switchTo().activeElement()).getId() === await driver.findElement(locator).getId()), TIMEOUT);
}

export async function countIs(locator, count) {
  await driver.wait(async () => (await driver.findElements(locator)).length === count, TIMEOUT);
}
