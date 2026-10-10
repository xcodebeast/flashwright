import { FrameLocator, type Page, type Frame, type Locator } from 'flashwright';

/** Lazy frame descriptors preserve the public library export and locator types. */
async function frameLocators(page: Page, frame: Frame, locator: Locator): Promise<void> {
  const pageFrame: FrameLocator = page.frameLocator('iframe');
  const childFrame: FrameLocator = frame.frameLocator('iframe');
  const scopedFrame: FrameLocator = locator.frameLocator('iframe');
  const contentFrame: FrameLocator = locator.contentFrame();
  const nestedFrame: FrameLocator = pageFrame.first().frameLocator('iframe').last().nth(0);
  const owner: Locator = nestedFrame.owner();
  const bySelector: Locator = pageFrame.locator('button', { hasText: 'Save', visible: true });
  const byLocator: Locator = pageFrame.locator(page.locator('button'), { hasNotText: /Cancel/ });
  const byText: Locator = pageFrame.getByText('Save', { exact: true });
  const byLabel: Locator = pageFrame.getByLabel(/Name/);
  const byTestId: Locator = pageFrame.getByTestId('submit');
  const byRole: Locator = pageFrame.getByRole('button', { name: 'Save', exact: true });
  const byPlaceholder: Locator = pageFrame.getByPlaceholder('Name');
  const byAltText: Locator = pageFrame.getByAltText(/Portrait/);
  const byTitle: Locator = pageFrame.getByTitle('Details');
  const publicConstructor: typeof FrameLocator = FrameLocator;
  await bySelector.click();
  const count: number = await byLocator.count();
  // @ts-expect-error Frame selectors must be strings.
  page.frameLocator(42);
  // @ts-expect-error Frame selectors do not accept an existing locator.
  frame.frameLocator(locator);
  // @ts-expect-error FrameLocator.locator accepts a selector or Locator.
  pageFrame.locator(42);
  // @ts-expect-error Frame indexes must be numbers.
  pageFrame.nth('first');
  // @ts-expect-error A frame descriptor is not an element action target.
  pageFrame.click();
  // @ts-expect-error contentFrame describes the existing locator without another selector.
  locator.contentFrame('iframe');
  void childFrame; void scopedFrame; void contentFrame; void owner; void byText; void byLabel;
  void byTestId; void byRole; void byPlaceholder; void byAltText; void byTitle;
  void publicConstructor; void count;
}
void frameLocators;
