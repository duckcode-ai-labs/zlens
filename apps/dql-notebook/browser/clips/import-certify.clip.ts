import { clip, expect, openAndRecord } from './support/clip-test';

const SQL = `select l.location_name, count(*) as order_count
from dev.orders o
join dev.locations l on o.location_id = l.location_id
group by 1
order by 2 desc`;

/** Build blocks: import SQL as a draft, save it (never certifies), then Certify explicitly and get a receipt. */
clip('import-certify', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject());
  await openAndRecord(page, director, server.baseUrl);

  await director.click(page.getByRole('button', { name: 'Blocks', exact: true }).first());
  await director.click(page.getByRole('button', { name: 'Start import' }));
  const sql = page.getByPlaceholder(/select \.\.\./);
  await director.click(sql, { after: 200 });
  await sql.fill(SQL);
  await director.beat(900);
  await director.type(page.getByPlaceholder('auto'), 'commerce', { clear: true });
  await director.type(page.getByPlaceholder('analytics'), 'analytics@jaffle.shop', { clear: true, delay: 25 });
  await director.click(page.getByRole('button', { name: 'Generate DQL drafts' }), { after: 300 });

  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await director.fastForward(() => expect(save).toBeEnabled({ timeout: 60_000 }));
  await director.beat(1400);
  await expect(page.getByRole('button', { name: 'Certify', exact: true })).toBeDisabled();
  await director.click(save, { after: 400 });
  await director.fastForward(() => expect(page.getByText('draft saved · needs review').first()).toBeVisible({ timeout: 30_000 }));
  await director.point(page.getByText('draft saved · needs review').first());
  await director.beat(1500);

  const certify = page.getByRole('button', { name: 'Certify', exact: true });
  await expect(certify).toBeEnabled();
  await director.click(certify, { after: 300 });
  await director.fastForward(() => expect(page.getByRole('button', { name: 'Certified', exact: true })).toBeVisible({ timeout: 60_000 }));
  await director.beat(800);
  await director.point(page.getByText(/1 certified/).first());
  await director.beat(1600);

  // The receipt: open the certified block in Block Studio.
  await director.click(page.getByRole('button', { name: /^commerce\b/ }).first(), { after: 500 });
  await director.click(page.getByRole('button', { name: /^Top Locations By Order Count commerce/ }).first(), { after: 600 });
  const receipt = page.getByTestId('block-certification-receipt');
  await expect(receipt).toContainText(/Certified by \w/);
  director.poster();
  await director.point(receipt, { x: -14, y: 8 });
  await director.beat(2800);
});
