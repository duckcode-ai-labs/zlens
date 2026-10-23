import { describe, expect, it } from 'vitest';
import { NOT_CERTIFIED_YET, READER_TRUST_LABELS, appTrustSummary, certifiedByAcross, changedSinceCertifiedDetail, checkedNotCertifiedDetail, readerTrustCounts, certifiedByLabel, certifiedDateLabel, certifierDisplayName, plainCertificationChecks, readerTileTrust, readerTrustSummary } from './reader-trust.js';

describe('shared reader trust (RFC 0008 steps 6 and 10)', () => {
  it('gives the server and the reader one answer for the same run tile', () => {
    expect(readerTileTrust({ query: {} }, { status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'adapted' } } })?.state).toBe('certified');
    expect(readerTileTrust({ query: {} }, { status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'needs_review' } } })?.state).toBe('review');
    // A total over a Top N saved query's rows runs, but is not a certified total (0.2.4).
    const topRows = readerTileTrust({ query: {} }, { status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'adapted', adaptations: [{ kind: 'saved_query_rollup', message: 'Totals only the 10 rows top_beverage_customers keeps (it is a Top 10), not all of the data, so it is not a certified total.', topRowsOnly: 10 }] } } });
    expect(topRows?.state).toBe('review');
    expect(topRows?.label).toBe(NOT_CERTIFIED_YET);
    expect(topRows?.detail).toContain('Totals only the 10 rows top_beverage_customers keeps');
    expect(readerTileTrust({ semantic: {} }, { status: 'ok', tileType: 'semantic' })?.state).toBe('governed');
    expect(readerTileTrust({ block: {} }, { status: 'error' })?.state).toBe('blocked');
    expect(readerTileTrust({ text: { markdown: 'x' } }, { status: 'ok', tileType: 'text' })).toBeNull();
  });

  it('keeps a certified Dataset tile certified through a certified join, and a drafted join keeps it Not certified yet (D2)', () => {
    const joined = (trust: string) => ({ status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'covered' }, joins: [{ trust, sentence: 'Joined to customers on customer_id (each order has one customer — checked)' }] } });
    expect(readerTileTrust({ query: {} }, joined('certified'))?.state).toBe('certified');
    const review = readerTileTrust({ query: {} }, joined('review_required'));
    expect(review?.state).toBe('review');
    expect(review?.label).toBe('Not certified yet');
    expect(review?.detail).toBe('Uses a join nobody has certified.');
  });

  it('summarises a page', () => {
    const certified = readerTileTrust({ block: {} }, { status: 'ok', certificationStatus: 'certified' });
    const review = readerTileTrust({ block: {} }, { status: 'ok' });
    expect(readerTrustSummary([certified, certified, null])).toEqual({ certified: 2, total: 2, text: 'All tiles certified' });
    expect(readerTrustSummary([certified, review]).text).toBe('1 of 2 tiles certified');
    expect(readerTrustSummary([null]).text).toBe('');
  });

  it('gives an App page one aggregate trust from its current run, never from saved claims', () => {
    const items = [{ i: 'a', block: { ref: 'blocks/_drafts/x.dql' } }, { i: 'note', text: { markdown: 'x' } }];
    expect(appTrustSummary(items, undefined)).toMatchObject({ state: 'pending', allCertified: false, total: 1 });
    const review = appTrustSummary(items, new Map([['a', { status: 'ok', trustState: 'review_required' }]]));
    expect(review).toMatchObject({ state: 'review', certified: 0, total: 1, allCertified: false, text: '0 of 1 tile certified' });
    const certified = appTrustSummary(items, [{ tileId: 'a', status: 'ok', certificationStatus: 'certified' }]);
    expect(certified).toMatchObject({ state: 'certified', allCertified: true, label: 'All tiles certified', text: 'All tiles certified' });
    expect(appTrustSummary(items, [{ tileId: 'a', status: 'ok', certificationStatus: 'certified' }], { pendingDrafts: 1 }).allCertified).toBe(false);
  });

  // D5: "Certified" always says who and when.
  const now = new Date('2026-10-25T12:00:00');
  it('says who certified and when, or just when for an old certification', () => {
    expect(certifiedByLabel({ by: 'maria@acme.com', name: 'Maria Lopez', at: '2026-10-21T10:00:00' }, now)).toBe('Certified by Maria Lopez · 21 Oct');
    expect(certifiedByLabel({ by: 'maria.lopez@acme.com', at: '2026-10-21T10:00:00' }, now)).toBe('Certified by Maria Lopez · 21 Oct');
    expect(certifiedByLabel({ by: '12345+kranthi@users.noreply.github.com', at: '2025-03-02T10:00:00' }, now)).toBe('Certified by Kranthi · 2 Mar 2025');
    expect(certifiedByLabel({ by: 'local', at: '2026-10-21T10:00:00' }, now)).toBe('Certified · 21 Oct');
    expect(certifiedByLabel({}, now)).toBe('Certified');
    expect(certifiedByLabel(null, now)).toBe('Certified');
    expect(certifierDisplayName('guest@local')).toBeUndefined();
    expect(certifiedDateLabel('not a date')).toBeUndefined();
  });

  it('lists the checks that passed in plain words, keeping sentences as written', () => {
    expect(plainCertificationChecks(['Row key: each row is one order (order_id is filled and different on all 3 rows)', 'run', 'tests', 'run'])).toEqual([
      'Row key: each row is one order (order_id is filled and different on all 3 rows)',
      'Ran without errors',
      'Its tests passed',
    ]);
    expect(plainCertificationChecks(undefined)).toEqual([]);
  });

  it('puts who and when on a certified tile, and never on one that needs review', () => {
    const certification = { by: 'maria@acme.com', name: 'Maria', at: new Date().toISOString(), checks: ['run'] };
    const dataset = readerTileTrust({ query: {} }, { status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'covered' } }, certification });
    expect(dataset).toMatchObject({ state: 'certified', label: 'Certified', checks: ['Ran without errors'] });
    expect(dataset?.byline).toMatch(/^Certified by Maria · \d{1,2} [A-Z][a-z]{2}$/);
    expect(readerTileTrust({ block: {} }, { status: 'ok', certificationStatus: 'certified' })?.byline).toBe('Certified');
    expect(readerTileTrust({ block: {} }, { status: 'ok', certification })?.byline).toBeUndefined();
  });

  it('names every certifier once on the page line, with the latest date', () => {
    expect(certifiedByAcross([{ name: 'Maria', at: '2026-10-01T10:00:00' }, { name: 'Maria', at: '2026-10-21T10:00:00' }], now)).toBe('Certified by Maria · 21 Oct');
    expect(certifiedByAcross([{ name: 'Maria' }, { by: 'kranthi@acme.com', at: '2026-10-02T10:00:00' }], now)).toBe('Certified by Maria and Kranthi · 2 Oct');
    expect(certifiedByAcross([{ name: 'A' }, { name: 'B' }, { name: 'C' }], now)).toBe('Certified by A and 2 others');
    expect(certifiedByAcross([], now)).toBeUndefined();
    const items = [{ i: 'a', block: {} }, { i: 'b', query: {} }];
    const tiles = [
      { tileId: 'a', status: 'ok', certificationStatus: 'certified', certification: { name: 'Maria', at: new Date().toISOString() } },
      { tileId: 'b', status: 'ok', dataset: { trust: 'certified' }, certification: { name: 'Maria', at: new Date().toISOString() } },
    ];
    expect(appTrustSummary(items, tiles).byline).toMatch(/^Certified by Maria · /);
    // With no receipt recorded anywhere there is nothing to add to the count.
    expect(appTrustSummary(items, tiles.map(({ certification: _c, ...tile }) => tile)).byline).toBeUndefined();
  });

  it('says "by you" when the reader certified it, and names everyone else (design Q1)', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    expect(certifiedByLabel({ by: 'kranthi@example.test', name: 'Kranthi', at: '2026-10-22T09:00:00Z', byYou: true }, now)).toBe('Certified by you · 22 Oct');
    expect(certifiedByLabel({ by: 'maria@example.test', name: 'Maria', at: '2026-10-22T09:00:00Z' }, now)).toBe('Certified by Maria · 22 Oct');
    expect(certifiedByAcross([{ name: 'Kranthi', byYou: true, at: '2026-10-21T09:00:00Z' }, { name: 'Kranthi', byYou: true, at: '2026-10-22T09:00:00Z' }], now)).toBe('Certified by you · 22 Oct');
    expect(certifiedByAcross([{ name: 'Maria', at: '2026-10-21T09:00:00Z' }, { name: 'Kranthi', byYou: true, at: '2026-10-22T09:00:00Z' }], now)).toBe('Certified by you and Maria · 22 Oct');
    const summary = appTrustSummary([{ i: 'a', query: {} }], new Map([['a', { status: 'ok', dataset: { trust: 'certified' }, certification: { name: 'Kranthi', byYou: true, at: '2026-10-22T09:00:00Z' } }]]));
    expect(summary.byline).toMatch(/^Certified by you · 22 Oct/);
  });

  it('says two words to people — Certified or Not certified yet — with the reason in the receipt (T1)', () => {
    expect(Object.values(READER_TRUST_LABELS).filter((label) => label !== 'Blocked').sort()).toEqual(['Certified', NOT_CERTIFIED_YET, NOT_CERTIFIED_YET]);
    const checked = readerTileTrust({ query: {} }, { status: 'ok', dataset: { trust: 'review_required', checked: true } });
    expect(checked).toMatchObject({ state: 'review', label: 'Not certified yet', detail: 'Checked, not certified yet.' });
    expect(readerTileTrust({ query: {} }, { status: 'ok', dataset: { trust: 'review_required' } })).toMatchObject({ state: 'review', label: 'Not certified yet' });
    // A saved query whose certification no longer holds says since when.
    const changed = readerTileTrust({ block: {} }, { status: 'ok', certification: { at: '2026-10-22T09:00:00Z' } });
    expect(changed).toMatchObject({ label: 'Not certified yet' });
    expect(changed?.detail).toMatch(/^Changed since it was certified on 22 Oct/);
    expect(changedSinceCertifiedDetail(null)).toBeUndefined();
    expect(checkedNotCertifiedDetail({ byYou: true })).toBe('Checked by you, not certified yet.');
    expect(checkedNotCertifiedDetail({ by: 'maria.lopez@acme.com' })).toBe('Checked by Maria Lopez, not certified yet.');
    expect(checkedNotCertifiedDetail(null)).toBe('Checked, not certified yet.');
    // A legacy semantic-model result reads Not certified yet, never "Governed".
    expect(readerTileTrust({ semantic: {} }, { status: 'ok', tileType: 'semantic' })?.label).toBe('Not certified yet');
    // No retired word anywhere in what a reader sees.
    const retired = /needs review|needs certifying|governed|draft|checked ·/i;
    for (const trust of [checked, changed, readerTileTrust({ semantic: {} }, { status: 'ok', tileType: 'semantic' })]) {
      expect(`${trust?.label} ${trust?.detail}`).not.toMatch(retired);
    }
  });

  it('counts the Trust Lens in two words plus Blocked', () => {
    const certified = readerTileTrust({ block: {} }, { status: 'ok', certificationStatus: 'certified' });
    const review = readerTileTrust({ block: {} }, { status: 'ok' });
    const semantic = readerTileTrust({ semantic: {} }, { status: 'ok', tileType: 'semantic' });
    expect(readerTrustCounts([certified, review, semantic])).toEqual([
      { state: 'certified', label: 'Certified', count: 1 },
      { state: 'review', label: 'Not certified yet', count: 2 },
    ]);
  });

  it('a calculation over certified data is certified (T2)', () => {
    const calc = readerTileTrust({ query: { calculations: [{}] } }, { status: 'ok', dataset: { trust: 'certified' } });
    expect(calc).toMatchObject({ state: 'certified', label: 'Certified' });
  });
});
