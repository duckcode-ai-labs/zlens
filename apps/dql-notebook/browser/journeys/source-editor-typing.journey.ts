import { test, expect } from '../support/test';

/**
 * Editing DQL Source key by key, in a real browser against the built CLI (see
 * ../global-setup.ts). With a block's closing brace gone, the check reports the
 * problem on the empty line after the text. The editor underlines that error
 * and used to throw there: a blank page, and the unsaved text lost.
 */

test.use({ viewport: { width: 1280, height: 800 } });

const draft = [
  '// dql-format: 1',
  '// A draft block.',
  '',
  'block "Paid claims" {',
  '  type = "custom"',
  '  status = "draft"',
  '  owner = "analytics"',
  '  description = "Paid claims"',
  '',
  '  query = """',
  '-- check this first',
  'SELECT 1',
  '"""',
  '}',
  '',
].join('\n');

test('DQL Source keeps working when a key leaves an error past the last line', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved queries', exact: true }).first().click();
  await page.getByText('Manual options').click();
  await page.getByRole('button', { name: /Blank SQL query/ }).click();
  await page.getByRole('button', { name: 'DQL Source', exact: true }).click();

  const editor = page.locator('.cm-content').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(draft);
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();

  // Take away the closing brace: "Expected RightBrace" arrives on the empty last line.
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(page.getByText('Expected RightBrace', { exact: false }).first()).toBeVisible();

  await expect(page.getByTestId('editor-failed')).toHaveCount(0);
  await expect(editor).toContainText('-- check this first');

  // The person carries on typing where they were, and the block is valid again.
  await page.keyboard.type('}', { delay: 20 });
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  await expect(page.getByTestId('editor-failed')).toHaveCount(0);
});
