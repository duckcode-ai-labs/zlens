import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { termCertificationFingerprint, termMeaningInSource, writeTermCertificationReceipt } from '@zlens/core';
import { ensureMetadataCatalogFresh, planAgentAnswer } from './catalog.js';

/**
 * End-to-end routing test for the additive `conflict` route. Two certified
 * terms claim the same concept (`active_customer`) but disagree on their
 * definition + business rules. A question that surfaces both must route to
 * `conflict` with both sides + owners — never a silent pick.
 */
describe('conflict route', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-conflict-route-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'growth_ops' }), 'utf-8');
    mkdirSync(join(projectRoot, 'terms'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeConflictingTerms(): void {
    writeFileSync(
      join(projectRoot, 'terms', 'active_customer_marketing.dql'),
      `term "Active Customer Marketing" {
  domain = "growth"
  type = "metric"
  status = "certified"
  owner = "marketing-analytics"
  identifiers = ["active_customer"]
  tags = ["active", "customer", "engagement"]
  description = "An active customer engaged in the last 30 days."
  businessRules = ["active if last_event within 30 days"]
}`,
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'terms', 'active_customer_finance.dql'),
      `term "Active Customer Finance" {
  domain = "finance"
  type = "metric"
  status = "certified"
  owner = "finance-analytics"
  identifiers = ["active_customer"]
  tags = ["active", "customer", "payment"]
  description = "An active customer who paid an invoice in the last 90 days."
  businessRules = ["active if last_payment within 90 days"]
}`,
      'utf-8',
    );
    // A term is certified only through its receipt.
    for (const [file, name] of [['terms/active_customer_marketing.dql', 'Active Customer Marketing'], ['terms/active_customer_finance.dql', 'Active Customer Finance']]) {
      const meaning = termMeaningInSource(readFileSync(join(projectRoot, file), 'utf-8'), name)!;
      writeTermCertificationReceipt(projectRoot, file, name, { certifiedBy: 'steward', certifiedAt: '2026-10-29T00:00:00.000Z', via: 'cli', termSha256: termCertificationFingerprint(meaning) });
    }
  }

  it('routes a question matching a conflicting certified pair to the conflict route', async () => {
    writeConflictingTerms();
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const plan = await planAgentAnswer(projectRoot, {
      question: 'What is the definition of an active customer marketing vs finance?',
      limit: 40,
    });

    expect(plan.routeDecision.route).toBe('conflict');
    expect(plan.routeDecision.trustLabel).toBe('conflict');
    expect(plan.routeDecision.reviewStatus).toBe('conflict');

    const conflict = plan.routeDecision.routeConflict;
    expect(conflict).toBeDefined();
    expect(conflict?.objectType).toBe('term');
    expect(conflict?.concept).toBe('active_customer');
    // BOTH sides + owners surfaced for human disambiguation.
    expect(conflict?.sides.map((s) => s.name).sort()).toEqual([
      'Active Customer Finance',
      'Active Customer Marketing',
    ]);
    expect(conflict?.sides.map((s) => s.owner).sort()).toEqual([
      'finance-analytics',
      'marketing-analytics',
    ]);
    expect(plan.routeDecision.followUps[0]).toMatch(/authoritative/i);
  });

  it('does not route to conflict when no conflicting pair exists', async () => {
    writeFileSync(
      join(projectRoot, 'terms', 'active_customer.dql'),
      `term "Active Customer" {
  domain = "growth"
  type = "metric"
  status = "certified"
  owner = "growth-analytics"
  identifiers = ["active_customer"]
  tags = ["active", "customer"]
  description = "An active customer engaged in the last 30 days."
  businessRules = ["active if last_event within 30 days"]
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const plan = await planAgentAnswer(projectRoot, {
      question: 'What is the definition of an active customer?',
      limit: 40,
    });

    expect(plan.routeDecision.route).not.toBe('conflict');
    expect(plan.routeDecision.routeConflict).toBeUndefined();
  });

  it('does not hijack an unrelated question even when a conflict exists elsewhere', async () => {
    writeConflictingTerms();
    // Add an unrelated certified term so an unrelated question has something to match.
    writeFileSync(
      join(projectRoot, 'terms', 'gross_margin.dql'),
      `term "Gross Margin" {
  domain = "finance"
  type = "metric"
  status = "certified"
  owner = "finance-analytics"
  identifiers = ["gross_margin"]
  tags = ["gross", "margin", "profitability"]
  description = "Revenue minus cost of goods sold over revenue."
  businessRules = ["gross_margin = (revenue - cogs) / revenue"]
}`,
      'utf-8',
    );
    await ensureMetadataCatalogFresh(projectRoot, { force: true });

    const plan = await planAgentAnswer(projectRoot, {
      question: 'What is the definition of gross margin?',
      limit: 40,
    });

    expect(plan.routeDecision.route).not.toBe('conflict');
    expect(plan.routeDecision.routeConflict).toBeUndefined();
  });
});
