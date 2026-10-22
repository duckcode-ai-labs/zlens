import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../parser/parser.js';
import { NodeKind } from '../ast/nodes.js';
import { formatDQL } from '../formatter/formatter.js';
import { buildManifest } from './builder.js';
import { unreadableFilterParts } from './metric-mapping.js';

const block = (mapping: string) => `block "Open Claims by Region" {
  domain = "claims"
  type = "custom"
  status = "certified"
  outputs = ["region", "open_claims"]
${mapping}
  query = """SELECT region, COUNT(DISTINCT claim_id) AS open_claims FROM claims WHERE status = 'open' GROUP BY region"""
}`;

const MAPPED = block(`  metricMappings {
    open_claims {
      metric = "claim_count"
      filter = "status = 'open'"
    }
  }`);

describe('metricMappings grammar', () => {
  it('parses the mapping onto the block', () => {
    const statement = parse(MAPPED).statements[0];
    if (statement.kind !== NodeKind.BlockDecl) throw new Error('expected block');
    expect(statement.metricMappings).toMatchObject([{ output: 'open_claims', metric: 'claim_count', filter: "status = 'open'" }]);
  });

  it('formats idempotently and keeps the mapping', () => {
    const formatted = formatDQL(MAPPED.replace(/\n\s*/g, ' '));
    expect(formatted).toContain('metricMappings {');
    expect(formatDQL(formatted)).toBe(formatted);
    const reparsed = parse(formatted).statements[0];
    if (reparsed.kind !== NodeKind.BlockDecl) throw new Error('expected block');
    expect(reparsed.metricMappings).toMatchObject([{ output: 'open_claims', metric: 'claim_count', filter: "status = 'open'" }]);
  });

  it('requires a metric on every entry', () => {
    expect(() => parse(block(`  metricMappings {\n    open_claims {\n      filter = "status = 'open'"\n    }\n  }`))).toThrow(/Parse errors/);
  });

  it('reads plain conditions and flags the rest', () => {
    expect(unreadableFilterParts("status = 'open' AND is_active AND region in ('N', 'S')")).toEqual([]);
    expect(unreadableFilterParts("status = 'open' AND region LIKE 'N%'")).toEqual(["region LIKE 'N%'"]);
  });
});

describe('buildManifest metricMappings checks', () => {
  let projectRoot: string;

  const metric = (name: string) => writeFileSync(join(projectRoot, 'semantic-layer', 'metrics', `${name}.yaml`), [
    `name: ${name}`, 'label: Claim count', 'domain: claims', 'status: certified', 'sql: claim_id', 'type: count_distinct', 'table: claims', '',
  ].join('\n'));
  const errors = () => (buildManifest({ projectRoot, dqlVersion: 'test' }).diagnostics ?? []).filter((d) => d.severity === 'error' && /metricMappings/.test(d.message));

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-metric-mapping-'));
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    mkdirSync(join(projectRoot, 'semantic-layer', 'metrics'), { recursive: true });
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'mapping', semanticLayer: { provider: 'dql', path: './semantic-layer' } }));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a mapping to a metric in the semantic layer compiles and reaches the manifest', () => {
    metric('claim_count');
    writeFileSync(join(projectRoot, 'blocks', 'open_claims.dql'), MAPPED);
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(errors()).toEqual([]);
    expect(manifest.blocks['Open Claims by Region']?.metricMappings).toEqual([{ output: 'open_claims', metric: 'claim_count', filter: "status = 'open'" }]);
  });

  it('a mapping to a metric that does not exist fails the build', () => {
    metric('claim_total');
    writeFileSync(join(projectRoot, 'blocks', 'open_claims.dql'), MAPPED);
    expect(errors().map((d) => d.message).join(' ')).toMatch(/maps to metric "claim_count", which is not in the semantic layer/);
  });

  it('a mapping for a column the block does not output, or a filter that is not a plain condition, fails the build', () => {
    metric('claim_count');
    writeFileSync(join(projectRoot, 'blocks', 'open_claims.dql'), block(`  metricMappings {\n    total {\n      metric = "claim_count"\n      filter = "region LIKE 'N%'"\n    }\n  }`));
    const messages = errors().map((d) => d.message).join(' ');
    expect(messages).toMatch(/"total" is not an output column of the saved query/);
    expect(messages).toMatch(/not "column = value" conditions: region LIKE 'N%'/);
  });
});
