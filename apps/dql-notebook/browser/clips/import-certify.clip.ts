import { join } from 'node:path';
import { clip, expect, openAndRecord } from './support/clip-test';
import { writeLegacyReports } from './support/legacy-reports';

/**
 * Import SQL from a folder of reports (a Tableau workbook, a Power BI template, an old SQL script): one draft per
 * query, what has no SQL listed under Left out, Certify all that ran, and the receipt on a certified saved query.
 */
clip('import-certify', async ({ page, sample, director }) => {
  const project = sample.freshProject();
  writeLegacyReports(join(project, 'legacy'));
  const server = await sample.serve(project);
  await openAndRecord(page, director, server.baseUrl);

  await director.click(page.getByRole('button', { name: 'Saved queries', exact: true }).first());
  await director.click(page.getByRole('button', { name: 'Start import' }));
  await director.click(page.getByRole('button', { name: 'Local path', exact: true }), { after: 300 });
  await director.type(page.getByPlaceholder(/^\.\/queries/), './legacy', { clear: true });
  await director.beat(500);
  await director.type(page.getByPlaceholder('auto'), 'commerce', { clear: true });
  await director.type(page.getByPlaceholder('analytics'), 'analytics@jaffle.shop', { clear: true, delay: 25 });
  await director.click(page.getByRole('button', { name: 'Generate DQL drafts' }), { after: 300 });

  // One draft per query: the workbook's Custom SQL, the template's native queries, the script's report.
  const certifyAll = page.getByRole('button', { name: /^Certify all that ran \(\d+\)$/ });
  await director.fastForward(() => expect(certifyAll).toBeVisible({ timeout: 120_000 }));
  await director.beat(900);
  await director.point(page.getByText(/revenue\.twb#Orders\/Revenue by store/).first());
  await director.beat(1200);
  await director.point(page.getByText(/Sales\.pbit#Store revenue by month/).first());
  await director.beat(1200);

  // What has no SQL to bring: calculated fields, DAX measures, table loads, and the script's DROP.
  const leftOut = page.locator('summary').filter({ hasText: /^Left out \(\d+\)$/ }).first();
  await leftOut.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await director.beat(600);
  await director.click(leftOut, { after: 700 });
  const dropped = page.getByText('Changes data (DROP). ZLens imports only queries that read.').first();
  await dropped.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await director.beat(700);
  await director.point(page.getByText(/DAX measures are not imported/).first());
  await director.beat(1300);
  await director.point(dropped);
  await director.beat(1300);

  // Certify all that ran: each draft is checked on its own and gets its own receipt.
  await certifyAll.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await director.beat(500);
  await director.click(certifyAll, { after: 300 });
  const summary = page.getByText(/^Certified (\d+) of \1\.$/).first();
  await director.fastForward(() => expect(summary).toBeVisible({ timeout: 120_000 }));
  await director.beat(600);
  await director.point(summary);
  await director.beat(1600);

  // The receipt: open a certified saved query.
  await director.click(page.getByRole('button', { name: /^commerce\b/ }).first(), { after: 500 });
  await director.click(page.getByRole('button', { name: /^Revenue By Store commerce/ }).first(), { after: 600 });
  const receipt = page.getByTestId('block-certification-receipt');
  await expect(receipt).toContainText(/Certified by \w/);
  director.poster();
  await director.point(receipt, { x: -14, y: 8 });
  await director.beat(2800);
});
