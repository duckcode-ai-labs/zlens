import { askQuestion, waitForAnswer } from './support/ask';
import { clip, expect, openAndRecord } from './support/clip-test';

/** Ask: a question the data cannot answer is refused, with the reason, instead of a guess. */
clip('ask-refusal', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject());
  await openAndRecord(page, director, server.baseUrl);

  await director.click(page.getByRole('button', { name: 'Ask', exact: true }));
  await askQuestion(page, director, 'What is our employee churn rate?');
  await waitForAnswer(page, director);

  // A question the data does not hold is answered calmly as "Not in this data" (V13); a failure reads "Couldn't run this query".
  const label = page.getByText('Not in this data').or(page.getByText("Couldn't run this query")).or(page.getByText('Couldn’t run this query')).first();
  await expect(label).toBeVisible();
  await director.point(label);
  await director.beat(1200);
  director.poster();
  await director.point(page.getByText(/No query was run/).first(), { x: 200, y: 10 });
  await director.beat(2600);
  await director.click(page.getByRole('button', { name: 'How it was answered' }).last(), { after: 2600 });
});
