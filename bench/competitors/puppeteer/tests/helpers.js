// What a Puppeteer user writes once: selectors for a todo by its exact title, and assertions that
// wait for a condition (Puppeteer has no assertion library).
const timeout = 5000;

const literal = text => JSON.stringify(text);
const itemOf = text => text === undefined ? ".todo-list li" : `::-p-xpath(//ul[contains(@class,"todo-list")]/li[.//label[text()=${literal(text)}]])`;
const todoOf = text => `::-p-xpath(//ul[contains(@class,"todo-list")]/li//label[text()=${literal(text)}])`;
const toggleOf = text => `::-p-xpath(//ul[contains(@class,"todo-list")]/li[.//label[text()=${literal(text)}]]//input[contains(@class,"toggle")])`;
const deleteOf = text => text === undefined ? ".todo-list li .destroy" : `::-p-xpath(//ul[contains(@class,"todo-list")]/li[.//label[text()=${literal(text)}]]//button[contains(@class,"destroy")])`;

const expectText = (selector, text) => page.waitForFunction((selector, text) => document.querySelector(selector)?.textContent === text, { timeout }, selector, text);
const expectValue = (selector, value) => page.waitForFunction((selector, value) => document.querySelector(selector)?.value === value, { timeout }, selector, value);
const expectChecked = (title, checked) => page.waitForFunction((title, checked) => {
  const items = [...document.querySelectorAll(".todo-list li")];
  const item = title === undefined ? items[0] : items.find(item => item.querySelector('label')?.textContent === title);
  return item?.querySelector('.toggle')?.checked === checked;
}, { timeout }, title, checked);
const expectFocused = selector => page.waitForFunction(selector => document.activeElement === document.querySelector(selector), { timeout }, selector);
const expectCount = (selector, count) => page.waitForFunction((selector, count) => document.querySelectorAll(selector).length === count, { timeout }, selector, count);
const expectTexts = (selector, texts) => page.waitForFunction((selector, texts) => JSON.stringify([...document.querySelectorAll(selector)].map(element => element.textContent)) === JSON.stringify(texts), { timeout }, selector, texts);
const expectUrlEnding = suffix => page.waitForFunction(suffix => location.href.endsWith(suffix), { timeout }, suffix);

module.exports = { timeout, itemOf, todoOf, toggleOf, deleteOf, expectText, expectValue, expectChecked, expectFocused, expectCount, expectTexts, expectUrlEnding };
