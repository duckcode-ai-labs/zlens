import { askQuestion, waitForAnswer } from './support/ask';
import { clip, expect, openAndRecord } from './support/clip-test';

/**
 * The README GIF and docs home: a first answer, its Certified label, the App
 * that shows the same certified block, and the lineage from dbt to that App.
 */
clip('overview', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject());
  await openAndRecord(page, director, server.baseUrl);

  // 1. A first answer, from a certified block.
  await director.click(page.getByRole('button', { name: 'Ask', exact: true }));
  await askQuestion(page, director, 'How has revenue changed by month?');
  await waitForAnswer(page, director);
  const label = page.getByText('Certified answer', { exact: true }).first();
  await expect(label).toBeVisible();
  await director.point(label);
  await director.beat(1400);
  director.poster();
  await director.point(page.getByText('monthly_revenue', { exact: true }).first());
  await director.beat(1200);
  await director.click(page.getByRole('button', { name: 'Visualization', exact: true }).first(), { after: 1800 });
  await director.click(page.getByRole('button', { name: 'How it was answered' }).last(), { after: 400 });
  await expect(page.getByText('How it answered', { exact: true }).first()).toBeVisible();
  await director.beat(2600);

  // 2. The App built from the same certified blocks.
  await director.click(page.getByRole('button', { name: 'Apps', exact: true }).first(), { after: 500 });
  await director.click(page.getByText('Jaffle Growth Review').first(), { after: 300 });
  // The header seal and the page's trust line both read "All tiles certified" (#168, #170).
  const seal = page.locator('.dql-app-view-topbar .dql-app-seal').filter({ hasText: 'All tiles certified' }).first();
  await director.fastForward(() => expect(seal).toBeVisible({ timeout: 60_000 }));
  await director.beat(500);
  await director.point(seal);
  await director.beat(1400);
  await director.moveTo(720, 600);
  await director.scroll(520);
  await director.point(page.getByText('Monthly gross revenue').first());
  await director.beat(1600);

  // 3. Lineage: dbt sources and models → the block → the App.
  await director.click(page.getByRole('button', { name: 'Lineage', exact: true }), { after: 400 });
  await director.click(page.getByRole('button', { name: 'monthly_revenue', exact: true }));
  const node = (text: string) => page.locator('.react-flow__node', { hasText: text }).first();
  await expect(node('Jaffle Growth Review')).toBeVisible();
  await director.beat(1500);
  await director.click(node('orders'), { after: 1400 });
  await director.click(node('Jaffle Growth Review'), { after: 2600 });
});
