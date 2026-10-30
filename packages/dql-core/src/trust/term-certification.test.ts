import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest } from '../manifest/builder.js';
import {
  readTermCertificationReceipts,
  removeTermCertificationReceipt,
  setTermStatusInSource,
  termCertificationFingerprint,
  termCertificationReceiptPath,
  termMeaningInSource,
  writeTermCertificationReceipt,
} from './term-certification.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-term-certification-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
  mkdirSync(join(root, 'terms'), { recursive: true });
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REVENUE = `// dql-format: 1

// Owned by the growth team.
term "Revenue" {
  domain = "commerce"
  status = "certified"
  description = "Gross money paid for orders."
  owner = "analytics@shop"
  synonyms = ["sales", "gross revenue"]
}

term "Order" {
  status = "draft"
  description = "One checkout."
}
`;

function certify(root: string, file: string, name: string): void {
  const meaning = termMeaningInSource(readFileSync(join(root, file), 'utf-8'), name)!;
  writeTermCertificationReceipt(root, file, name, { certifiedBy: 'kranthi', certifiedByName: 'Kranthi', certifiedAt: '2026-10-29T12:00:00.000Z', via: 'modeling', termSha256: termCertificationFingerprint(meaning) });
}

describe('term certification fingerprint', () => {
  it('ignores the status and the order of lists, and changes when the meaning changes', () => {
    const base = { name: 'Revenue', description: 'Gross money paid.', synonyms: ['sales', 'gross revenue'] };
    expect(termCertificationFingerprint({ ...base, synonyms: ['gross revenue', ' sales ', 'sales'] })).toBe(termCertificationFingerprint(base));
    expect(termCertificationFingerprint({ ...base, ...{ status: 'certified' } } as never)).toBe(termCertificationFingerprint(base));
    expect(termCertificationFingerprint({ ...base, description: 'Net money paid.' })).not.toBe(termCertificationFingerprint(base));
    expect(termCertificationFingerprint({ ...base, synonyms: ['sales'] })).not.toBe(termCertificationFingerprint(base));
  });
});

describe('setting a term status in its file', () => {
  it('changes only that term, keeps comments and the other terms, and adds a status line when there is none', () => {
    const certifiedOrder = setTermStatusInSource(REVENUE, 'Order', 'certified');
    expect(certifiedOrder).toContain('// Owned by the growth team.');
    expect(termMeaningInSource(certifiedOrder, 'Order')?.status).toBe('certified');
    expect(termMeaningInSource(certifiedOrder, 'Revenue')?.status).toBe('certified');
    expect(certifiedOrder.replace('status = "certified"\n  description = "One checkout."', 'status = "draft"\n  description = "One checkout."')).toBe(REVENUE);

    const noStatus = 'term "Churn" {\n  description = "A customer who left."\n}\n';
    const inserted = setTermStatusInSource(noStatus, 'Churn', 'certified');
    expect(termMeaningInSource(inserted, 'Churn')).toMatchObject({ status: 'certified', description: 'A customer who left.' });
    expect(() => setTermStatusInSource(noStatus, 'Missing', 'certified')).toThrow(/No term named "Missing"/);
  });
});

describe('a term counts as certified only through its receipt', () => {
  it('reads a term that says certified without a receipt as a draft, with a warning that says how to certify it', () => {
    const root = project();
    writeFileSync(join(root, 'terms', 'revenue.dql'), REVENUE, 'utf-8');
    const manifest = buildManifest({ projectRoot: root, dqlVersion: 'test' });
    expect(manifest.terms?.Revenue).toMatchObject({ status: 'draft', certificationIssue: 'no_receipt' });
    expect(manifest.terms?.Revenue?.certification).toBeUndefined();
    expect(manifest.terms?.Order).toMatchObject({ status: 'draft' });
    expect(manifest.terms?.Order?.certificationIssue).toBeUndefined();
    const warning = manifest.diagnostics.find((diagnostic) => diagnostic.message.includes('term "Revenue" says certified'));
    expect(warning).toMatchObject({ severity: 'warning', filePath: 'terms/revenue.dql' });
    expect(warning?.message).toContain('no receipt in terms/revenue.certification.yaml');
  });

  it('reads a term certified with a matching receipt as certified, with who certified it', () => {
    const root = project();
    writeFileSync(join(root, 'terms', 'revenue.dql'), REVENUE, 'utf-8');
    certify(root, 'terms/revenue.dql', 'Revenue');
    expect(readFileSync(join(root, 'terms', 'revenue.certification.yaml'), 'utf-8')).toContain('# ZLens certification receipts');
    const manifest = buildManifest({ projectRoot: root, dqlVersion: 'test' });
    expect(manifest.terms?.Revenue).toMatchObject({ status: 'certified', certification: { certifiedBy: 'kranthi', certifiedByName: 'Kranthi', certifiedAt: '2026-10-29T12:00:00.000Z' } });
    expect(manifest.terms?.Revenue?.certificationIssue).toBeUndefined();
    expect(manifest.diagnostics.some((diagnostic) => diagnostic.message.includes('says certified'))).toBe(false);
  });

  it('reads a certified term edited after it was certified as a draft, while reformatting or reordering synonyms keeps it certified', () => {
    const root = project();
    writeFileSync(join(root, 'terms', 'revenue.dql'), REVENUE, 'utf-8');
    certify(root, 'terms/revenue.dql', 'Revenue');

    writeFileSync(join(root, 'terms', 'revenue.dql'), REVENUE.replace('["sales", "gross revenue"]', '["gross revenue",   "sales"]').replace('// Owned by the growth team.', ''), 'utf-8');
    expect(buildManifest({ projectRoot: root, dqlVersion: 'test' }).terms?.Revenue?.status).toBe('certified');

    writeFileSync(join(root, 'terms', 'revenue.dql'), REVENUE.replace('Gross money paid for orders.', 'Net money paid for orders.'), 'utf-8');
    const edited = buildManifest({ projectRoot: root, dqlVersion: 'test' });
    expect(edited.terms?.Revenue).toMatchObject({ status: 'draft', certificationIssue: 'changed' });
    expect(edited.diagnostics.find((diagnostic) => diagnostic.message.includes('term "Revenue"'))?.message).toContain('edited after it was certified');
  });

  it('never reads a term in a notebook cell as certified: a cell has no receipt file', () => {
    expect(termCertificationReceiptPath('notebooks/terms.dqlnb#cell-1')).toBeNull();
    expect(termCertificationReceiptPath('domains/commerce/terms/revenue.dql')).toBe('domains/commerce/terms/revenue.certification.yaml');
  });

  it('keeps the other terms\' receipts when one is removed, and deletes the file with the last one', () => {
    const root = project();
    writeFileSync(join(root, 'terms', 'revenue.dql'), setTermStatusInSource(REVENUE, 'Order', 'certified'), 'utf-8');
    certify(root, 'terms/revenue.dql', 'Revenue');
    certify(root, 'terms/revenue.dql', 'Order');
    expect(Object.keys(readTermCertificationReceipts(root, 'terms/revenue.dql')).sort()).toEqual(['Order', 'Revenue']);
    expect(removeTermCertificationReceipt(root, 'terms/revenue.dql', 'Order')).toBe(true);
    expect(Object.keys(readTermCertificationReceipts(root, 'terms/revenue.dql'))).toEqual(['Revenue']);
    expect(buildManifest({ projectRoot: root, dqlVersion: 'test' }).terms?.Order?.status).toBe('draft');
    expect(removeTermCertificationReceipt(root, 'terms/revenue.dql', 'Revenue')).toBe(true);
    expect(existsSync(join(root, 'terms', 'revenue.certification.yaml'))).toBe(false);
    expect(removeTermCertificationReceipt(root, 'terms/revenue.dql', 'Revenue')).toBe(false);
  });
});
