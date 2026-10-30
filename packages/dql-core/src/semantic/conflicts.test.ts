import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../manifest/builder.js';
import { detectTrustConflicts } from './conflicts.js';
import { termCertificationFingerprint, termMeaningInSource, writeTermCertificationReceipt } from '../trust/term-certification.js';
import type { ManifestBlock, ManifestTerm } from '../manifest/types.js';

function term(partial: Partial<ManifestTerm> & { name: string }): ManifestTerm {
  return {
    filePath: `terms/${partial.name}.dql`,
    domain: 'sales',
    status: 'certified',
    ...partial,
  };
}

function block(partial: Partial<ManifestBlock> & { name: string; sql: string }): ManifestBlock {
  return {
    filePath: `blocks/${partial.name}.dql`,
    domain: 'sales',
    status: 'certified',
    rawTableRefs: [],
    tableDependencies: [],
    refDependencies: [],
    allDependencies: [],
    tests: [],
    ...partial,
  };
}

describe('detectTrustConflicts (unit)', () => {
  it('flags two certified terms that share an identifier but disagree on business rules', () => {
    const terms = {
      'Active Customer (Marketing)': term({
        name: 'Active Customer (Marketing)',
        owner: 'marketing-analytics',
        identifiers: ['active_customer'],
        description: 'A customer who engaged in the last 30 days.',
        businessRules: ['active if last_event within 30 days'],
      }),
      'Active Customer (Finance)': term({
        name: 'Active Customer (Finance)',
        owner: 'finance-analytics',
        identifiers: ['active_customer'],
        description: 'A customer who paid an invoice in the last 90 days.',
        businessRules: ['active if last_payment within 90 days'],
      }),
    };

    const diagnostics = detectTrustConflicts(terms, {});
    expect(diagnostics).toHaveLength(1);
    const diag = diagnostics[0];
    expect(diag.kind).toBe('conflict');
    expect(diag.severity).toBe('warning');
    expect(diag.conflict?.objectType).toBe('term');
    expect(diag.conflict?.concept).toBe('active_customer');
    expect(diag.conflict?.sides.map((s) => s.name).sort()).toEqual([
      'Active Customer (Finance)',
      'Active Customer (Marketing)',
    ]);
    // Both owners surfaced so a human can pick the winner.
    expect(diag.conflict?.sides.map((s) => s.owner).sort()).toEqual([
      'finance-analytics',
      'marketing-analytics',
    ]);
    expect(diag.conflict?.prompt).toMatch(/which one is authoritative/i);
  });

  it('does NOT flag terms that share an identifier but agree (no divergence)', () => {
    const terms = {
      'Active Customer A': term({
        name: 'Active Customer A',
        identifiers: ['active_customer'],
        description: 'A customer active in the last 30 days.',
        businessRules: ['active if last_event within 30 days'],
      }),
      'Active Customer B': term({
        name: 'Active Customer B',
        identifiers: ['active_customer'],
        description: 'A customer active in the last 30 days.',
        businessRules: ['active if last_event within 30 days'],
      }),
    };
    expect(detectTrustConflicts(terms, {})).toEqual([]);
  });

  it('does NOT flag terms with no shared identifier (different concepts)', () => {
    const terms = {
      'Active Customer': term({
        name: 'Active Customer',
        identifiers: ['active_customer'],
        description: 'A customer active in the last 30 days.',
      }),
      'Churned Customer': term({
        name: 'Churned Customer',
        identifiers: ['churned_customer'],
        description: 'A customer inactive for 180 days.',
      }),
    };
    expect(detectTrustConflicts(terms, {})).toEqual([]);
  });

  it('does NOT flag a draft term against a certified one', () => {
    const terms = {
      'Active Customer (Draft)': term({
        name: 'Active Customer (Draft)',
        status: 'draft',
        identifiers: ['active_customer'],
        description: 'WIP definition.',
        businessRules: ['active if last_event within 7 days'],
      }),
      'Active Customer (Certified)': term({
        name: 'Active Customer (Certified)',
        status: 'certified',
        identifiers: ['active_customer'],
        description: 'A customer active in the last 30 days.',
        businessRules: ['active if last_event within 30 days'],
      }),
    };
    expect(detectTrustConflicts(terms, {})).toEqual([]);
  });

  it('flags two certified blocks sharing a grain/entity but with divergent SQL', () => {
    const blocks = {
      'Revenue (Net)': block({
        name: 'Revenue (Net)',
        grain: 'month',
        entities: ['revenue'],
        sql: 'SELECT month, SUM(net_amount) AS revenue FROM fct_sales GROUP BY 1',
      }),
      'Revenue (Gross)': block({
        name: 'Revenue (Gross)',
        grain: 'month',
        entities: ['revenue'],
        sql: 'SELECT month, SUM(gross_amount) AS revenue FROM fct_sales GROUP BY 1',
      }),
    };
    const diagnostics = detectTrustConflicts({}, blocks);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].conflict?.objectType).toBe('block');
    expect(diagnostics[0].conflict?.concept).toBe('revenue');
  });

  it('does NOT flag certified blocks with different grains (legitimately different questions)', () => {
    const blocks = {
      'Revenue Monthly': block({
        name: 'Revenue Monthly',
        grain: 'month',
        entities: ['revenue'],
        sql: 'SELECT month, SUM(net_amount) AS revenue FROM fct_sales GROUP BY 1',
      }),
      'Revenue Daily': block({
        name: 'Revenue Daily',
        grain: 'day',
        entities: ['revenue'],
        sql: 'SELECT day, SUM(net_amount) AS revenue FROM fct_sales GROUP BY 1',
      }),
    };
    expect(detectTrustConflicts({}, blocks)).toEqual([]);
  });
});

describe('conflict detection through buildManifest (compile)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-conflict-'));
    writeFileSync(join(tmpDir, 'dql.config.json'), '{"project":"conflict-demo"}');
    mkdirSync(join(tmpDir, 'terms'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a kind:conflict diagnostic for two certified terms defining the same concept differently', () => {
    writeFileSync(
      join(tmpDir, 'terms', 'active_customer_marketing.dql'),
      `term "Active Customer (Marketing)" {
  domain = "growth"
  type = "metric"
  status = "certified"
  owner = "marketing-analytics"
  identifiers = ["active_customer"]
  description = "A customer who engaged in the last 30 days."
  businessRules = ["active if last_event within 30 days"]
}`,
      'utf-8',
    );
    writeFileSync(
      join(tmpDir, 'terms', 'active_customer_finance.dql'),
      `term "Active Customer (Finance)" {
  domain = "finance"
  type = "metric"
  status = "certified"
  owner = "finance-analytics"
  identifiers = ["active_customer"]
  description = "A customer who paid an invoice in the last 90 days."
  businessRules = ["active if last_payment within 90 days"]
}`,
      'utf-8',
    );

    // Only certified terms conflict, and a term is certified through its receipt.
    for (const [file, name] of [['terms/active_customer_marketing.dql', 'Active Customer (Marketing)'], ['terms/active_customer_finance.dql', 'Active Customer (Finance)']]) {
      const meaning = termMeaningInSource(readFileSync(join(tmpDir, file), 'utf-8'), name)!;
      writeTermCertificationReceipt(tmpDir, file, name, { certifiedBy: 'steward', certifiedAt: '2026-10-29T00:00:00.000Z', via: 'cli', termSha256: termCertificationFingerprint(meaning) });
    }

    const manifest = buildManifest({ projectRoot: tmpDir });
    const conflicts = (manifest.diagnostics ?? []).filter((d) => d.kind === 'conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflict?.concept).toBe('active_customer');
    expect(conflicts[0].conflict?.sides.map((s) => s.owner).sort()).toEqual([
      'finance-analytics',
      'marketing-analytics',
    ]);
  });

  it('does not emit a conflict diagnostic for unrelated certified terms', () => {
    writeFileSync(
      join(tmpDir, 'terms', 'active_customer.dql'),
      `term "Active Customer" {
  domain = "growth"
  type = "metric"
  status = "certified"
  identifiers = ["active_customer"]
  description = "Active in the last 30 days."
  businessRules = ["active if last_event within 30 days"]
}`,
      'utf-8',
    );
    writeFileSync(
      join(tmpDir, 'terms', 'churned_customer.dql'),
      `term "Churned Customer" {
  domain = "growth"
  type = "metric"
  status = "certified"
  identifiers = ["churned_customer"]
  description = "Inactive for 180 days."
  businessRules = ["churned if inactive 180 days"]
}`,
      'utf-8',
    );

    const manifest = buildManifest({ projectRoot: tmpDir });
    expect((manifest.diagnostics ?? []).filter((d) => d.kind === 'conflict')).toEqual([]);
  });
});
