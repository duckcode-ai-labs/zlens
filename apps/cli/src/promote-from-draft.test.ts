import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { promoteFromDraft, type PromotionGate } from './promote-from-draft.js';
import type { CLIFlags } from './args.js';


const passGate: PromotionGate = async () => ({ ok: true, blockers: [], checks: ['metadata', 'run', 'tests'], warnings: [] });
const promote = (root: string, flags: CLIFlags) => promoteFromDraft(root, flags, { gate: passGate, certifiedBy: 'reviewer@example.com' });

function baseFlags(overrides: Partial<CLIFlags> = {}): CLIFlags {
  return {
    format: 'text',
    verbose: false,
    help: false,
    version: false,
    check: false,
    open: null,
    input: '',
    outDir: '',
    port: null,
    host: null,
    chart: '',
    domain: '',
    owner: '',
    queryOnly: false,
    template: '',
    connection: '',
    skipTests: false,
    force: false,
    http: false,
    ...overrides,
  };
}

function writeDraft(
  root: string,
  slug: string,
  body?: { domain?: string; proposedContractId?: string; status?: string },
) {
  writeDraftAt(root, join(root, 'blocks', '_drafts'), slug, body);
}

function writeDomainDraft(
  root: string,
  domain: string,
  slug: string,
  body?: { domain?: string; proposedContractId?: string; status?: string },
) {
  writeDraftAt(root, join(root, 'domains', domain, 'blocks', '_drafts'), slug, { ...body, domain: body?.domain ?? domain });
}

function writeDraftAt(
  root: string,
  draftDir: string,
  slug: string,
  body?: { domain?: string; proposedContractId?: string; status?: string },
) {
  mkdirSync(draftDir, { recursive: true });
  const domain = body?.domain ?? 'customer';
  const id = body?.proposedContractId ?? 'commerce.Customer.monthly_active_customers';
  const status = body?.status ?? 'draft';
  writeFileSync(
    join(draftDir, `${slug}.dql`),
    `block "${slug}" {
    domain = "${domain}"
    type = "custom"
    status = "${status}"
    description = """How many active customers each month?"""
    datalex_contract = ""

    _proposed {
        asked_times = 3
        first_asked = "2026-04-01T00:00:00Z"
        last_asked = "2026-05-01T12:00:00Z"
        proposed_contract_id = "${id}"
        proposed_domain = "${domain}"
        proposed_entity = "Customer"
    }

    query = """SELECT 1"""
}
`,
  );
}

describe('promoteFromDraft (zlens certify --from-draft)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'promote-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drops the draft hash from the certified file name, unless that name is taken', async () => {
    writeDomainDraft(tmp, 'finance', 'monthly-revenue-a9a82c329b13');
    const first = await promote(tmp, baseFlags({ fromDraft: 'domains/finance/blocks/_drafts/monthly-revenue-a9a82c329b13.dql', owner: 'a@example.com' }));
    expect(first.ok, first.message).toBe(true);
    expect(first.certifiedPath).toBe('domains/finance/blocks/monthly-revenue.dql');

    writeDomainDraft(tmp, 'finance', 'monthly-revenue-68fb0abbc481');
    const second = await promote(tmp, baseFlags({ fromDraft: 'domains/finance/blocks/_drafts/monthly-revenue-68fb0abbc481.dql', owner: 'a@example.com' }));
    expect(second.ok, second.message).toBe(true);
    expect(second.certifiedPath).toBe('domains/finance/blocks/monthly-revenue-68fb0abbc481.dql');
  });

  it('returns ok=false when the draft path does not exist', async () => {
    const out = await promote(tmp, baseFlags({ fromDraft: 'blocks/_drafts/nope.dql' }));
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not found/i);
  });

  it('refuses to promote a file whose status is not draft', async () => {
    writeDraft(tmp, 'mau', { status: 'certified' });
    const out = await promote(tmp, baseFlags({ fromDraft: 'blocks/_drafts/mau.dql' }));
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/status="draft"/);
  });

  it('promotes a draft to blocks/<domain>/<slug>.dql, flips status, sets contract, drops _proposed', async () => {
    writeDraft(tmp, 'mau');
    const out = await promote(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
        owner: 'growth@example.com',
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.certifiedPath).toBe('blocks/customer/mau.dql');

    const certified = readFileSync(join(tmp, 'blocks/customer/mau.dql'), 'utf-8');
    expect(certified).toContain('status = "certified"');
    expect(certified).toContain('datalex_contract = "commerce.Customer.monthly_active_customers@1"');
    expect(certified).toContain('owner = "growth@example.com"');
    expect(certified).not.toContain('_proposed');
    expect(certified).not.toContain('asked_times');

    expect(existsSync(join(tmp, 'blocks/_drafts/mau.dql'))).toBe(false);
  });

  it('preserves Dataset tile review-draft provenance as derived_from on later certification', async () => {
    const provenance = JSON.stringify({
      version: 1,
      kind: 'dataset_tile_provenance',
      appId: 'app.commerce', pageId: 'overview', tileId: 'revenue',
      datasetId: 'dataset:commerce:orders', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract',
      query: { dimensions: [], measures: [{ measure: 'revenue' }] }, queryFingerprint: 'sha256:query',
      filterFingerprint: 'sha256:filters', parameterFingerprint: 'sha256:params', interactionFingerprint: 'sha256:interactions',
      snapshotFingerprint: 'sha256:snapshot', targetFingerprint: 'sha256:target', personaPolicyFingerprint: 'sha256:policy',
      receiptId: 'app_run_1', sqlFingerprint: 'sha256:sql', schemaFingerprint: 'sha256:schema', resultFingerprint: 'sha256:result',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    const draftDir = join(tmp, 'blocks', '_drafts');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, 'revenue.dql'), `block "Revenue" {
  domain = "commerce"
  type = "custom"
  status = "draft"
  dataset_tile_provenance = ${JSON.stringify(provenance)}
  query = """SELECT SUM(net_amount) AS revenue FROM order_lines"""
}\n`);

    const out = await promote(tmp, baseFlags({ fromDraft: 'blocks/_drafts/revenue.dql', domain: 'commerce' }));

    expect(out.ok).toBe(true);
    const certified = readFileSync(join(tmp, 'blocks', 'commerce', 'revenue.dql'), 'utf-8');
    expect(certified).toContain('derived_from = ');
    expect(certified).not.toContain('dataset_tile_provenance = ');
  });

  it('promotes a domain-first draft into domains/<domain>/blocks/<slug>.dql', async () => {
    writeDomainDraft(tmp, 'customer', 'mau');
    const out = await promote(
      tmp,
      baseFlags({
        fromDraft: 'domains/customer/blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.certifiedPath).toBe('domains/customer/blocks/mau.dql');
    expect(existsSync(join(tmp, 'domains/customer/blocks/_drafts/mau.dql'))).toBe(false);
    expect(readFileSync(join(tmp, 'domains/customer/blocks/mau.dql'), 'utf-8')).toContain('status = "certified"');
    expect(existsSync(join(tmp, 'blocks/customer/mau.dql'))).toBe(false);
  });

  it('promotes a legacy draft into the domain-first folder when the domain exists', async () => {
    mkdirSync(join(tmp, 'domains', 'customer'), { recursive: true });
    writeDraft(tmp, 'mau');
    const out = await promote(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.certifiedPath).toBe('domains/customer/blocks/mau.dql');
    expect(readFileSync(join(tmp, 'domains/customer/blocks/mau.dql'), 'utf-8')).toContain('datalex_contract = "commerce.Customer.monthly_active_customers@1"');
  });

  it('falls back to the proposed contract id with @1 when --contract is omitted', async () => {
    writeDraft(tmp, 'mau', {
      proposedContractId: 'commerce.Customer.monthly_active_customers',
    });
    const out = await promote(
      tmp,
      baseFlags({ fromDraft: 'blocks/_drafts/mau.dql', domain: 'customer' }),
    );
    expect(out.ok).toBe(true);
    const certified = readFileSync(join(tmp, 'blocks/customer/mau.dql'), 'utf-8');
    expect(certified).toContain('datalex_contract = "commerce.Customer.monthly_active_customers@1"');
  });

  it('promotes an OSS draft without requiring a DataLex contract', async () => {
    writeDraft(tmp, 'mau', { proposedContractId: '' });
    const out = await promote(tmp, baseFlags({ fromDraft: 'blocks/_drafts/mau.dql', domain: 'customer' }));
    expect(out.ok).toBe(true);
    expect(out.certifiedPath).toBe('blocks/customer/mau.dql');
    expect(out.datalexManifestDiff).toBeUndefined();

    const certified = readFileSync(join(tmp, 'blocks/customer/mau.dql'), 'utf-8');
    expect(certified).toContain('status = "certified"');
    expect(certified).not.toContain('datalex_contract = ""');
  });

  it('refuses to overwrite an existing certified file unless --force', async () => {
    writeDraft(tmp, 'mau');
    mkdirSync(join(tmp, 'blocks', 'customer'), { recursive: true });
    writeFileSync(join(tmp, 'blocks', 'customer', 'mau.dql'), 'already here');

    const out = await promote(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/already exists/);
  });

  it('overwrites with --force', async () => {
    writeDraft(tmp, 'mau');
    mkdirSync(join(tmp, 'blocks', 'customer'), { recursive: true });
    writeFileSync(join(tmp, 'blocks', 'customer', 'mau.dql'), 'old content');

    const out = await promote(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
        force: true,
      }),
    );
    expect(out.ok).toBe(true);
    const content = readFileSync(join(tmp, 'blocks/customer/mau.dql'), 'utf-8');
    expect(content).not.toBe('old content');
    expect(content).toContain('status = "certified"');
  });

  it('surfaces a datalex-manifest.json patch with the contract entry to add', async () => {
    writeDraft(tmp, 'mau');
    const out = await promote(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
      }),
    );
    expect(out.datalexManifestDiff).toBeDefined();
    expect(out.datalexManifestDiff!).toContain('commerce.Customer.monthly_active_customers');
    expect(out.datalexManifestDiff!).toContain('"version": 1');
    expect(out.datalexManifestDiff!).toContain('domains[name=commerce]');
    expect(out.datalexManifestDiff!).toContain('entities[name=Customer]');
  });

  it('certifies only when the certification rules pass: a failing gate writes nothing and keeps the draft', async () => {
    writeDraft(tmp, 'mau');
    const seen: string[] = [];
    const out = await promoteFromDraft(tmp, baseFlags({ fromDraft: 'blocks/_drafts/mau.dql', domain: 'customer', owner: 'growth@example.com' }), {
      gate: async ({ source }) => { seen.push(source); return { ok: false, blockers: ['All tests pass: 1 test(s) failed'] }; },
      certifiedBy: 'reviewer@example.com',
    });
    expect(out.ok).toBe(false);
    expect(out.blockers).toEqual(['All tests pass: 1 test(s) failed']);
    expect(out.message).toMatch(/not certified/);
    // The rules saw exactly the source that would have been certified.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('status = "certified"');
    expect(seen[0]).toContain('owner = "growth@example.com"');
    expect(existsSync(join(tmp, 'blocks/customer/mau.dql'))).toBe(false);
    expect(readFileSync(join(tmp, 'blocks/_drafts/mau.dql'), 'utf-8')).toContain('status = "draft"');
  });

  it('writes a certification receipt next to reviewStatus: certified in the companion YAML', async () => {
    writeDraft(tmp, 'mau');
    mkdirSync(join(tmp, 'semantic-layer', 'blocks', '_drafts'), { recursive: true });
    writeFileSync(join(tmp, 'semantic-layer', 'blocks', '_drafts', 'mau.yaml'), 'name: mau\nblock: mau\ndomain: _drafts\ntags:\n  - churn\nreviewStatus: draft\n');
    const out = await promoteFromDraft(tmp, baseFlags({ fromDraft: 'blocks/_drafts/mau.dql', domain: 'customer', owner: 'growth@example.com' }), {
      gate: passGate,
      certifiedBy: 'reviewer@example.com',
      now: new Date('2026-10-14T12:00:00.000Z'),
    });
    expect(out.ok).toBe(true);
    expect(out.companionPath).toBe('semantic-layer/blocks/customer/mau.yaml');
    const companion = readFileSync(join(tmp, out.companionPath!), 'utf-8');
    expect(companion).toContain('reviewStatus: certified');
    expect(companion).toContain('certifiedBy: reviewer@example.com');
    expect(companion).toContain("certifiedAt: '2026-10-14T12:00:00.000Z'");
    expect(companion).toContain('via: cli');
    expect(companion).toContain('rules: oss');
    expect(companion).toMatch(/sourceSha256: [0-9a-f]{64}/);
    expect(companion).toContain('  - churn');
    expect(companion).toContain('domain: customer');
    expect(companion.match(/reviewStatus:/g)).toHaveLength(1);
    expect(existsSync(join(tmp, 'semantic-layer', 'blocks', '_drafts', 'mau.yaml'))).toBe(false);
  });
});
