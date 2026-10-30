import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest } from './builder.js';
import { countTermDeclarations, deleteTermDeclaration, renderTermDeclaration, termFileSlug, writeTermDeclaration } from './term-writer.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-term-writer-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('term writer', () => {
  it('writes a term the manifest reads back with the fields Ask uses', () => {
    const root = project();
    const written = writeTermDeclaration(root, {
      name: 'Revenue',
      domain: 'commerce',
      termType: 'metric',
      status: 'draft',
      description: 'Gross money paid for orders,\nincluding "tax".',
      synonyms: ['sales', 'gross revenue', 'sales'],
      metricRefs: ['order_total'],
      businessRules: ['Use orders.order_total for gross revenue.'],
      caveats: ['Product revenue excludes tax.'],
      owner: 'analytics@shop',
    }, { directory: 'domains/commerce/terms' });

    expect(written.path).toBe('domains/commerce/terms/revenue.dql');
    const term = buildManifest({ projectRoot: root, dqlVersion: 'test' }).terms?.Revenue;
    expect(term).toMatchObject({
      name: 'Revenue',
      filePath: 'domains/commerce/terms/revenue.dql',
      domain: 'commerce',
      termType: 'metric',
      status: 'draft',
      description: 'Gross money paid for orders, including "tax".',
      synonyms: ['sales', 'gross revenue'],
      metricRefs: ['order_total'],
      businessRules: ['Use orders.order_total for gross revenue.'],
      caveats: ['Product revenue excludes tax.'],
      owner: 'analytics@shop',
    });
  });

  it('never overwrites another term file when creating, and updates in place when editing', () => {
    const root = project();
    writeTermDeclaration(root, { name: 'Customer' }, { directory: 'terms' });
    expect(() => writeTermDeclaration(root, { name: 'customer' }, { directory: 'terms' })).toThrow(/already exists/);
    writeTermDeclaration(root, { name: 'Customer', synonyms: ['shopper'] }, { directory: 'terms', existingPath: 'terms/customer.dql' });
    expect(readFileSync(join(root, 'terms/customer.dql'), 'utf-8')).toContain('synonyms = ["shopper"]');
  });

  it('refuses to rewrite or delete a file that holds several terms', () => {
    const root = project();
    mkdirSync(join(root, 'terms'), { recursive: true });
    writeFileSync(join(root, 'terms/glossary.dql'), 'term "A" {\n  type = "entity"\n}\n\nterm "B" {\n  type = "entity"\n}\n', 'utf-8');
    expect(countTermDeclarations(readFileSync(join(root, 'terms/glossary.dql'), 'utf-8'))).toBe(2);
    expect(() => writeTermDeclaration(root, { name: 'A' }, { directory: 'terms', existingPath: 'terms/glossary.dql' })).toThrow(/declares 2 terms/);
    expect(() => deleteTermDeclaration(root, 'terms/glossary.dql')).toThrow(/declares 2 terms/);
  });

  it('keeps writes inside the project and on .dql files', () => {
    const root = project();
    expect(() => writeTermDeclaration(root, { name: 'X' }, { directory: '../outside' })).toThrow(/outside the project/);
    expect(() => deleteTermDeclaration(root, 'dql.config.json')).toThrow(/not a .dql file/);
  });

  it('renders stable slugs and omits empty fields', () => {
    expect(termFileSlug('  Gross Revenue (USD) ')).toBe('gross_revenue_usd');
    expect(renderTermDeclaration({ name: 'Order', synonyms: [' ', ''], description: ' ' })).toBe('// dql-format: 1\n\nterm "Order" {\n}\n');
    expect(() => renderTermDeclaration({ name: '  ' })).toThrow(/needs a name/);
  });
});
