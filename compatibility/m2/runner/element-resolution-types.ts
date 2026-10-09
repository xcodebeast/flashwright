import { type Page, type Frame, type Locator, type JSHandle, type ElementHandle } from 'flashwright';

async function consumer(page: Page, frame: Frame, locator: Locator, argument: JSHandle<{ answer: number }>) {
  const button: ElementHandle<HTMLButtonElement> = await page.waitForSelector('button');
  const input: ElementHandle<HTMLInputElement> = await frame.waitForSelector('input', { state: 'attached', strict: true });
  const hidden: ElementHandle<SVGElement | HTMLElement> | null = await page.waitForSelector('#missing', { state: 'hidden' });
  const attached: ElementHandle<SVGElement | HTMLElement> | null = await locator.elementHandle({ timeout: 50 });
  const answer: number = await locator.evaluate((element, value) => element.textContent ? value.answer : 0, argument, { timeout: 50 });
  const text: string | null = await locator.evaluate(element => element.textContent);
  const result: JSHandle<number> = await locator.evaluateHandle((element, value) => value.answer, argument);
  const element: ElementHandle<HTMLButtonElement> = await locator.evaluateHandle((element: HTMLButtonElement) => element);
  // @ts-expect-error Callback arguments keep the borrowed handle's actual value type.
  await locator.evaluate((element, value) => value.missing, argument);
  // @ts-expect-error Callback element values keep their DOM type.
  await locator.evaluate(element => element.notAnElementMember);
  // @ts-expect-error Selector states must be supported names.
  await page.waitForSelector('button', { state: 'stable' });
  // @ts-expect-error Hidden state can return null.
  const required: ElementHandle<SVGElement | HTMLElement> = await page.waitForSelector('button', { state: 'hidden' });
  void button; void input; void hidden; void attached; void answer; void text; void result; void element; void required;
}
void consumer;
