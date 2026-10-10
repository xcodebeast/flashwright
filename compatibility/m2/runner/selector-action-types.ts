import type { Page, Frame } from 'flashwright';

/** Both selector scopes preserve the documented argument and Promise return shapes. */
async function actions(scope: Page | Frame): Promise<void> {
  await scope.click('button', { strict: false, force: true, timeout: 100, modifiers: ['Shift'], position: { x: 1, y: 2 } });
  await scope.dblclick('button', { strict: true, button: 'left', delay: 1 });
  await scope.hover('button', { strict: false, trial: true });
  await scope.check('input', { strict: true, noWaitAfter: true });
  await scope.uncheck('input', { strict: false });
  await scope.setChecked('input', false, { strict: true });
  await scope.fill('input', 'value', { strict: false, force: true });
  await scope.focus('input', { strict: true });
  const selected: string[] = await scope.selectOption('select', [{ label: 'First' }], { strict: false });
  await scope.press('input', 'Enter', { strict: true, delay: 1 });
  await scope.type('input', 'text', { strict: false, noWaitAfter: false });
  // @ts-expect-error Selector strictness is a boolean.
  await scope.click('button', { strict: 'true' });
  // @ts-expect-error A selector is required for the page and frame action forms.
  await scope.fill('value');
  // @ts-expect-error Locator strictness is fixed, not a public action option.
  await scope.locator('input').fill('value', { strict: false });
  // @ts-expect-error Checked state is a boolean.
  await scope.setChecked('input', 'true');
  // @ts-expect-error Typing does not accept force.
  await scope.type('input', 'text', { force: true });
  void selected;
}
void actions;
