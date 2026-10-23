import { clip, expect, openAndRecord } from './support/clip-test';

/** Apps: open an App, read its trust labels, and Ask from the App about what is on the page. */
clip('app-ask', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject());
  await openAndRecord(page, director, server.baseUrl);

  await director.click(page.getByText('Jaffle Growth Review').first(), { after: 300 });
  // The header seal and the page's trust line both read "All tiles certified" (#168, #170).
  const seal = page.locator('.dql-app-view-topbar .dql-app-seal').filter({ hasText: 'All tiles certified' }).first();
  await director.fastForward(() => expect(seal).toBeVisible({ timeout: 60_000 }));
  await director.beat(600);
  await director.point(seal);
  await director.beat(1300);
  await director.point(page.locator('.dql-trust-summary').filter({ hasText: 'All tiles certified' }).first());
  await director.beat(1000);
  await director.point(page.getByText('Certified', { exact: true }).first());
  await director.beat(1000);

  // The tiles, each with its own trust label.
  await director.moveTo(720, 600);
  await director.scroll(520);
  await director.point(page.getByText('Top beverage products').first());
  await director.beat(1300);
  await director.scroll(-520);

  // Ask from the App: scoped to this page and its tiles.
  const ask = page.getByPlaceholder(/Ask about Jaffle Growth Review/);
  await director.type(ask, 'How has revenue changed by month?');
  await director.click(page.getByRole('button', { name: 'Ask', exact: true }).last(), { after: 300 });
  // The caption promises a certified answer; a replay miss or refusal must fail the clip, not be recorded.
  const label = page.getByText('Certified answer', { exact: true }).first();
  await director.fastForward(() => expect(label).toBeVisible({ timeout: 240_000 }));
  await expect(page.getByText(/Scoped to Jaffle Growth Review/).last()).toBeVisible();
  await director.beat(900);
  director.poster();
  await director.point(label);
  await director.beat(3200);
});
