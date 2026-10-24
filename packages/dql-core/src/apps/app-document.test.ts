import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAppDocument,
  resolveRlsContext,
  findAppDocuments,
  suggestAppId,
  type AppDocument,
} from './app-document.js';

const minimalApp: AppDocument = {
  version: 1,
  id: 'growth-cxo',
  name: 'Growth — CXO',
  domain: 'growth',
  ownerDomain: 'growth',
  usesDomains: ['growth'],
  requiredExports: [],
  owners: ['alice@acme.com'],
  members: [
    { userId: 'alice@acme.com', roles: ['owner'], attributes: { region: 'NA' } },
    { userId: 'bob@acme.com', roles: ['viewer'], attributes: { region: 'EU' } },
  ],
  roles: [
    { id: 'owner' },
    { id: 'viewer' },
  ],
  policies: [
    {
      id: 'viewers-read',
      domain: 'growth',
      minClassification: 'internal',
      allowedRoles: ['viewer', 'owner'],
      accessLevel: 'read',
    },
  ],
};

describe('parseAppDocument', () => {
  it('parses a minimal valid App', () => {
    const { document, errors } = parseAppDocument(JSON.stringify(minimalApp));
    expect(errors).toEqual([]);
    expect(document?.id).toBe('growth-cxo');
    expect(document?.members).toHaveLength(2);
    expect(document?.visibility).toBe('shared');
    expect(document?.publicationIntent).toBe('shared_project');
    expect(document?.lifecycle).toBe('draft');
    // enabled defaults to true when omitted
    expect(document?.policies[0].enabled).toBe(true);
  });

  it('preserves an explicit shared publication target on a private draft', () => {
    const { document, errors } = parseAppDocument(JSON.stringify({
      ...minimalApp,
      visibility: 'private',
      publicationIntent: 'shared_project',
    }));

    expect(errors).toEqual([]);
    expect(document?.visibility).toBe('private');
    expect(document?.publicationIntent).toBe('shared_project');
  });

  it('parses OSS scope metadata and attached notebook refs', () => {
    const app = {
      ...minimalApp,
      visibility: 'template',
      subdomain: 'fraud',
      groups: ['daily-ops', 'cards'],
      audience: 'operations',
      lifecycle: 'review',
      notebooks: [
        {
          path: 'notebooks/cards_fraud_ops.dqlnb',
          title: 'Cards Fraud Ops',
          role: 'analysis',
          visibility: 'shared',
        },
      ],
    };
    const { document, errors } = parseAppDocument(JSON.stringify(app));
    expect(errors).toEqual([]);
    expect(document?.subdomain).toBe('fraud');
    expect(document?.groups).toEqual(['daily-ops', 'cards']);
    expect(document?.audience).toBe('operations');
    expect(document?.lifecycle).toBe('review');
    expect(document?.notebooks?.[0]).toEqual(app.notebooks[0]);
  });

  it('keeps the identity-provider groups an App is for, trimmed and once each', () => {
    const { document, errors } = parseAppDocument(JSON.stringify({ ...minimalApp, audienceGroups: [' claims-leaders ', 'claims-leaders', '', 'finance-leaders'] }));
    expect(errors).toEqual([]);
    expect(document?.audienceGroups).toEqual(['claims-leaders', 'finance-leaders']);
    expect(parseAppDocument(JSON.stringify(minimalApp)).document).not.toHaveProperty('audienceGroups');
    expect(parseAppDocument(JSON.stringify({ ...minimalApp, audienceGroups: 'claims-leaders' })).errors.length).toBeGreaterThan(0);
  });

  it('round-trips exact ProductDomainContext including explicit empty arrays', () => {
    const { document, errors } = parseAppDocument(JSON.stringify({
      ...minimalApp,
      usesDomains: [],
      requiredExports: [],
      purpose: 'Cross-domain revenue review',
      classification: 'internal',
    }));

    expect(errors).toEqual([]);
    expect(document).toMatchObject({
      ownerDomain: 'growth',
      usesDomains: [],
      purpose: 'Cross-domain revenue review',
      requiredExports: [],
      classification: 'internal',
    });
    expect(parseAppDocument(JSON.stringify(document)).document).toMatchObject({
      usesDomains: [],
      requiredExports: [],
    });
  });

  it('rejects invalid OSS metadata enums', () => {
    const bad = {
      ...minimalApp,
      visibility: 'workspace',
      lifecycle: 'gold',
      notebooks: [{ path: 'notebooks/a.dqlnb', role: 'owner' }],
    };
    const { document, errors } = parseAppDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors.some((e) => e.message.includes('"visibility"'))).toBe(true);
    expect(errors.some((e) => e.message.includes('"lifecycle"'))).toBe(true);
    expect(errors.some((e) => e.message.includes('notebooks[0].role'))).toBe(true);
  });

  it('rejects invalid JSON', () => {
    const { document, errors } = parseAppDocument('{ not json');
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/invalid JSON/);
  });

  it('errors when required fields are missing', () => {
    const { document, errors } = parseAppDocument('{}');
    expect(document).toBeNull();
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((e) => e.message.includes('"id"'))).toBe(true);
  });

  it('errors on undeclared role references', () => {
    const bad = {
      ...minimalApp,
      members: [{ userId: 'eve@acme.com', roles: ['ghost'] }],
    };
    const { document, errors } = parseAppDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors.some((e) => e.message.includes('undeclared role "ghost"'))).toBe(true);
  });

  it('rejects ids with unsafe folder characters', () => {
    const bad = { ...minimalApp, id: 'has spaces and / slash' };
    const { document, errors } = parseAppDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors.some((e) => e.message.includes('folder-safe'))).toBe(true);
  });

  it('round-trips schedules with slack delivery', () => {
    const app = {
      ...minimalApp,
      schedules: [
        {
          id: 'weekly',
          cron: '0 9 * * 1',
          dashboard: 'overview',
          deliver: [{ kind: 'slack', channel: '#growth' }],
        },
      ],
    };
    const { document, errors } = parseAppDocument(JSON.stringify(app));
    expect(errors).toEqual([]);
    expect(document?.schedules?.[0].deliver[0]).toEqual({ kind: 'slack', channel: '#growth' });
    expect(document?.schedules?.[0].enabled).toBe(true);
  });
});

describe('who certified an App (D5)', () => {
  it('keeps certifiedBy and certifiedAt only while the App is certified', () => {
    const certified = parseAppDocument(JSON.stringify({ ...minimalApp, lifecycle: 'certified', certifiedBy: 'Maria', certifiedAt: '2026-10-21T09:00:00.000Z' })).document!;
    expect(certified).toMatchObject({ certifiedBy: 'Maria', certifiedAt: '2026-10-21T09:00:00.000Z' });
    const review = parseAppDocument(JSON.stringify({ ...minimalApp, lifecycle: 'review', certifiedBy: 'Maria', certifiedAt: '2026-10-21T09:00:00.000Z' })).document!;
    expect(review).not.toHaveProperty('certifiedBy');
    expect(review).not.toHaveProperty('certifiedAt');
    expect(parseAppDocument(JSON.stringify({ ...minimalApp, lifecycle: 'certified', certifiedBy: 7 })).errors[0]?.message).toMatch(/certifiedBy/);
  });
});

describe('resolveRlsContext', () => {
  it('substitutes member attributes for matching role bindings', () => {
    const app: AppDocument = {
      ...minimalApp,
      rlsBindings: [
        { role: 'viewer', variable: 'user.region', from: 'region' },
      ],
    };
    const bob = app.members.find((m) => m.userId === 'bob@acme.com')!;
    expect(resolveRlsContext(app, bob)).toEqual({ 'user.region': 'EU' });
  });

  it('returns empty for owners with no matching bindings', () => {
    const app: AppDocument = {
      ...minimalApp,
      rlsBindings: [
        { role: 'viewer', variable: 'user.region', from: 'region' },
      ],
    };
    const alice = app.members.find((m) => m.userId === 'alice@acme.com')!;
    // owner has no viewer-bound RLS — context should be empty.
    expect(resolveRlsContext(app, alice)).toEqual({});
  });
});

describe('findAppDocuments', () => {
  it('discovers manifest files under apps/<id>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-apps-'));
    try {
      mkdirSync(join(root, 'apps', 'one'), { recursive: true });
      mkdirSync(join(root, 'apps', 'two'), { recursive: true });
      writeFileSync(join(root, 'apps', 'one', 'dql.app.json'), '{}');
      writeFileSync(join(root, 'apps', 'two', 'dql.app.json'), '{}');
      const found = findAppDocuments(root);
      expect(found).toHaveLength(2);
      expect(found[0].endsWith('one/dql.app.json')).toBe(true);
      expect(found[1].endsWith('two/dql.app.json')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers manifest files under domains/<domain>/apps/<id>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-domain-apps-'));
    try {
      mkdirSync(join(root, 'apps', 'root-app'), { recursive: true });
      mkdirSync(join(root, 'domains', 'customer', 'apps', 'customer-360'), { recursive: true });
      mkdirSync(join(root, 'domains', 'revenue', 'apps', 'revenue-review'), { recursive: true });
      writeFileSync(join(root, 'apps', 'root-app', 'dql.app.json'), '{}');
      writeFileSync(join(root, 'domains', 'customer', 'apps', 'customer-360', 'dql.app.json'), '{}');
      writeFileSync(join(root, 'domains', 'revenue', 'apps', 'revenue-review', 'dql.app.json'), '{}');

      const found = findAppDocuments(root).map((path) => path.replace(root, ''));

      expect(found).toEqual([
        '/apps/root-app/dql.app.json',
        '/domains/customer/apps/customer-360/dql.app.json',
        '/domains/revenue/apps/revenue-review/dql.app.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty when no apps/ exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-apps-'));
    try {
      expect(findAppDocuments(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('suggestAppId', () => {
  it('lowercases and strips unsafe characters', () => {
    expect(suggestAppId('Growth — CXO View')).toBe('growth-cxo-view');
  });
  it('returns "app" for an empty input', () => {
    expect(suggestAppId('   ')).toBe('app');
  });
});
