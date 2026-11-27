import { askQuestion, waitForAnswer } from './support/ask';
import { clip, expect, openAndRecord } from './support/clip-test';

/** Ask: no certified block fits, so the answer is AI-generated; Save keeps it as a draft to review and certify. */
clip('ask-review', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject());
  await openAndRecord(page, director, server.baseUrl);

  await director.click(page.getByRole('button', { name: 'Ask', exact: true }));
  await askQuestion(page, director, 'What is the average order value at each store?');
  await waitForAnswer(page, director);

  const label = page.getByText('AI-generated answer', { exact: true }).first();
  await expect(label).toBeVisible();
  // The stores are shown by name, in the table and in the answer, never by their UUID keys.
  await expect(page.getByText('Philadelphia', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Brooklyn', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/rows, starting with (Philadelphia|Brooklyn) · /).first()).toBeVisible();
  await expect(page.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)).toHaveCount(0);
  await director.point(label);
  await director.beat(1400);
  director.poster();
  // Ask saves nothing on its own: Save as saved query asks for the name and owner, then keeps a draft.
  await director.click(page.getByRole('button', { name: 'Save as saved query' }).last(), { after: 900 });
  const dialog = page.getByRole('dialog', { name: 'Save as a draft' });
  await expect(dialog).toBeVisible();
  await director.beat(1200);
  await director.click(dialog.getByRole('button', { name: 'Save draft' }), { after: 900 });
  const saved = page.getByText('Saved as a draft.', { exact: true }).last();
  await expect(saved).toBeVisible();
  await director.point(saved, { x: 60, y: 8 });
  await director.beat(1600);

  await director.click(page.getByRole('button', { name: 'Review it' }).last(), { after: 2800 });
});
