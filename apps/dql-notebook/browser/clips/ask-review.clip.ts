import { askQuestion, waitForAnswer } from './support/ask';
import { clip, expect, openAndRecord } from './support/clip-test';

/** Ask: no certified block fits, so the answer is AI-generated, needs review, and is saved as a draft block. */
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
  await expect(page.getByText(/Leading rows: (Philadelphia|Brooklyn) · /).first()).toBeVisible();
  await expect(page.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)).toHaveCount(0);
  await director.point(label);
  await director.beat(1400);
  director.poster();
  const saved = page.getByText(/Saved for review as a draft saved query/).first();
  await expect(saved).toBeVisible();
  await director.point(saved, { x: 120, y: 8 });
  await director.beat(1600);

  await director.click(page.getByRole('button', { name: 'Open draft to review' }).last(), { after: 2800 });
});
