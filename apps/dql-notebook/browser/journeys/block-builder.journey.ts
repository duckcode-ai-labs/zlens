import { test, expect } from '../support/test';

/**
 * B10, the SQL block builder, in a real browser at 1280 px against the built
 * CLI (see ../global-setup.ts): SQL typed in the Visual Builder survives
 * switching to DQL Source and back, "Global / cross-domain" stays global, Run
 * and Save draft are on screen, and Save draft writes the owner inside the
 * block, on a new block and again on the saved file (which opens with the
 * `// dql-format: 1` header).
 */

test.use({ viewport: { width: 1280, height: 800 } });

test('SQL block builder: SQL survives tab switches, Global stays global, Save draft writes a block that parses (B10)', async ({ page, request }) => {
  const name = `b10_store_revenue_${Date.now().toString(36)}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved queries', exact: true }).first().click();
  await page.getByText('Manual options').click();
  await page.getByRole('button', { name: /Blank SQL query/ }).click();

  const sqlBox = page.getByRole('textbox', { name: 'Saved query SQL' });
  await expect(sqlBox).toBeVisible();
  const sql = "select 'b10-' || cast(count(*) as varchar) as marker from dev.dim_customers";
  await sqlBox.fill(sql);

  // The SQL is in the draft: DQL Source shows it, and the builder shows it again after the switch.
  await page.getByRole('button', { name: 'DQL Source', exact: true }).click();
  await expect(page.locator('.cm-content').first()).toContainText("'b10-'");
  await page.getByRole('button', { name: 'Visual Builder', exact: true }).click();
  await expect(sqlBox).toHaveValue(sql);

  // "Global / cross-domain" is a choice, never "uncategorized (missing Domain page)".
  // The block's Details domain (the explorer has its own domain filter).
  const domain = page.locator('select[aria-label="Saved query domain"]:not(#block-domain-filter)');
  await domain.selectOption({ label: 'Global / cross-domain' });
  await expect(domain).toHaveValue('');
  await expect(domain.locator('option', { hasText: 'missing Domain page' })).toHaveCount(0);

  // Run and Save draft are on screen at 1280 px.
  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeInViewport();
  await expect(save).toBeInViewport();

  await save.click();
  const identity = page.getByRole('dialog', { name: 'Save query' });
  await expect(identity.getByText('Saving keeps it as a draft; certifying it is a separate step.', { exact: false })).toBeVisible();
  await identity.getByLabel('Saved query name').fill(name);
  await identity.getByLabel('Owner').fill('sales-analytics');
  await identity.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(identity).toBeHidden();
  await expect(page.getByText('This draft was not saved. Your work is still editable.')).toHaveCount(0);

  const findSaved = async (): Promise<string> => {
    const library = await (await request.get('/api/blocks/library')).json() as { blocks?: Array<{ path: string; name?: string }> } | Array<{ path: string; name?: string }>;
    const blocks = Array.isArray(library) ? library : library.blocks ?? [];
    return blocks.find((block) => block.path.includes(name) || block.name === name)?.path ?? '';
  };
  await expect.poll(findSaved, { timeout: 30_000 }).not.toBe('');
  const savedPath = await findSaved();
  const readSaved = async () => (await (await request.get(`/api/block-studio/open?path=${encodeURIComponent(savedPath)}`)).json() as { source: string }).source;
  const insideBlock = (source: string, text: string) => source.indexOf(text) >= 0 && source.indexOf(text) < source.lastIndexOf('}');
  let saved = await readSaved();
  expect(saved).toContain("'b10-'");
  expect(insideBlock(saved, 'owner = "sales-analytics"')).toBe(true);

  // Edit the saved file (it opens with the header) in the builder and save again.
  await page.getByRole('button', { name: /Open in DQL Source/ }).click();
  await page.getByRole('button', { name: 'Visual Builder', exact: true }).click();
  await expect(sqlBox).toHaveValue(sql);
  const edited = "select 'b10-edited-' || cast(count(*) as varchar) as marker from dev.dim_customers";
  await sqlBox.fill(edited);
  await page.getByRole('button', { name: 'DQL Source', exact: true }).click();
  await page.getByRole('button', { name: 'Visual Builder', exact: true }).click();
  await expect(sqlBox).toHaveValue(edited);
  await expect(save).toBeInViewport();
  await save.click();
  await expect(page.getByText('This draft was not saved. Your work is still editable.')).toHaveCount(0);
  await expect.poll(async () => (await readSaved()).includes("'b10-edited-'"), { timeout: 30_000 }).toBe(true);
  saved = await readSaved();
  expect(saved).toMatch(new RegExp(`block "${name}" \\{`));
  expect(insideBlock(saved, 'owner = "sales-analytics"')).toBe(true);
  expect(saved.match(/owner\s*=/g)).toHaveLength(1);

  // The journeys share one project: leave its block list as it was.
  const removed = await request.delete(`/api/block-studio/block?path=${encodeURIComponent(savedPath)}`);
  expect(removed.ok(), await removed.text()).toBe(true);
});
