import { expect, type Locator } from '@flashwright/test';

/** This file is compile-only: public runner matcher signatures accept pinned readonly inputs. */
async function commonMatchers(locator: Locator): Promise<void> {
  const classes = ['first', /second/u] as const;
  const selectedValues = ['one', /two/i] as const;
  await expect(locator).toHaveClass(classes);
  await expect(locator).not.toHaveClass(/first/);
  await expect(locator).toContainClass(['first', 'second'] as const);
  await expect(locator).toHaveCSS('color', /rgb/, { pseudo: 'before', timeout: 20 });
  await expect(locator).toHaveCSS('content', '"after"', { pseudo: 'after' });
  await expect(locator).toHaveId(/identifier/);
  await expect(locator).toHaveValues(selectedValues);
  await expect(locator).toHaveRole('button');
  await expect(locator).toHaveAccessibleName('Save', { ignoreCase: true });
  await expect(locator).toHaveAccessibleDescription(/details/, { ignoreCase: false });
  await expect(locator).toHaveAccessibleErrorMessage('Required', { timeout: 20 });
  await expect.soft(locator).toHaveClass('selected');
  await expect.configure({ timeout: 50 })(locator).toHaveValues([]);
  // @ts-expect-error Partial class matching only accepts literal class tokens.
  await expect(locator).toContainClass(/selected/);
  // @ts-expect-error The pinned CSS matcher only exposes before/after pseudo-elements.
  await expect(locator).toHaveCSS('content', 'value', { pseudo: 'marker' });
  // @ts-expect-error Multiple selected values require an array.
  await expect(locator).toHaveValues('one');
  // @ts-expect-error Role matching does not accept regular expressions.
  await expect(locator).toHaveRole(/button/);
}
void commonMatchers;
