import { test, expect } from '../support/test';

/**
 * A host's actions on an answer, in a real browser. The host and a saved
 * conversation are stubbed; what is under test is the card: "This looks wrong"
 * files nothing until the person presses Send, and their note goes with it.
 */

test.use({ viewport: { width: 1280, height: 800 } });

const thread = { id: 'thread-1', surface: 'ask', title: 'Paid claims', archived: false, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z' };
const turn = (overrides: Record<string, unknown>) => ({
  id: 'turn-1', threadId: thread.id, seq: 1, question: 'Claims paid last month?', answerSummary: 'Twelve claims.', answerText: 'Twelve claims.',
  createdAt: thread.createdAt, ...overrides,
});
const certified = turn({ route: 'certified_answer', trustLabel: 'certified', runStatus: 'completed', certification: 'certified', sql: 'SELECT 12 AS claims', result: { columns: ['claims'], rowsSample: [[12]], rowCount: 1 } });
const blocked = turn({ route: 'blocked', trustLabel: 'blocked', runStatus: 'blocked', stopReason: 'blocked', answerSummary: 'This question was blocked.', answerText: 'This question was blocked.' });

const answerActions = [
  { id: 'certify', label: 'Make this a certified answer', url: '/host/requests?kind=certify', on: ['review', 'unanswered'] },
  { id: 'wrong', label: 'This looks wrong', url: '/host/requests?kind=correction', on: ['answered', 'review'] },
];

async function openConversation(page: import('@playwright/test').Page, shownTurn: Record<string, unknown>) {
  const filed: Array<Record<string, unknown>> = [];
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/host/ui', (route) => route.fulfill(json({
    host: true,
    person: { id: 'u-1', name: 'Ana', kind: 'person' },
    capabilities: { ask: true, 'project.read': true },
    links: [],
    answerActions,
  })));
  await page.route('**/api/host/answer-status', (route) => route.fulfill(json({ statuses: {} })));
  await page.route('**/api/agent/threads?*', (route) => route.fulfill(json({ threads: [thread] })));
  await page.route('**/api/agent/threads', (route) => route.fulfill(json({ threads: [thread] })));
  await page.route(`**/api/agent/threads/${thread.id}`, (route) => route.fulfill(json({ thread, turns: [shownTurn], runs: [] })));
  await page.route('**/host/requests**', async (route) => {
    filed.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill(json({ message: 'Reported as R-7.' }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask', exact: true }).first().click();
  // The list names a chat by its title or its first question, depending on when it loaded.
  await page.getByRole('button', { name: /Paid claims|Claims paid last month/ }).first().click();
  await expect(page.getByText(String(shownTurn.answerSummary)).first()).toBeVisible();
  return filed;
}

test('"This looks wrong" asks for a note, files on Send, and the note goes with it', async ({ page }) => {
  const filed = await openConversation(page, certified);
  await page.getByRole('button', { name: 'This looks wrong', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'This looks wrong: note' });
  await expect(note).toBeFocused();
  expect(filed).toEqual([]);

  await note.fill('The total counts refunds twice.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reported as R-7.' })).toBeVisible();
  await expect(note).toBeHidden();
  expect(filed).toHaveLength(1);
  expect(filed[0]).toMatchObject({ question: 'Claims paid last month?', trustState: 'certified', note: 'The total counts refunds twice.' });
});

test('the note is optional, and Cancel files nothing', async ({ page }) => {
  const filed = await openConversation(page, certified);
  await page.getByRole('button', { name: 'This looks wrong', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'This looks wrong: note' })).toBeHidden();
  expect(filed).toEqual([]);

  await page.getByRole('button', { name: 'This looks wrong', exact: true }).click();
  await page.getByRole('textbox', { name: 'This looks wrong: note' }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Reported as R-7.' })).toBeVisible();
  expect(filed).toHaveLength(1);
  expect(filed[0]).not.toHaveProperty('note');
});

test('a blocked answer offers no certified answer, whatever the host says', async ({ page }) => {
  await openConversation(page, blocked);
  await expect(page.getByText('This question was blocked.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make this a certified answer', exact: true })).toHaveCount(0);
});
