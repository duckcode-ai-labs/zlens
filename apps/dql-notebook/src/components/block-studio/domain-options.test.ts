import { describe, expect, it } from 'vitest';
import { GLOBAL_BLOCK_DOMAIN, blockDomainOptions, blockDomainSelectValue, certifyNeedsDomain, isGlobalBlockDomain } from './domain-options';

describe('blockDomainOptions', () => {
  const domains = [
    { id: 'commerce', name: 'Commerce' },
    { id: 'commerce.customer', name: 'Customer', parent: 'commerce' },
    { id: 'growth', name: 'Growth' },
  ];

  it('uses only authored Domain pages and presents nested human labels', () => {
    expect(blockDomainOptions('commerce', domains)).toEqual([
      { value: 'commerce', label: 'Commerce' },
      { value: 'commerce.customer', label: 'Commerce / Customer' },
      { value: 'growth', label: 'Growth' },
    ]);
  });

  it('keeps an undeclared legacy assignment visible but disabled', () => {
    expect(blockDomainOptions('semantic-layer/metrics', domains)).toEqual([
      { value: 'semantic-layer/metrics', label: 'semantic-layer/metrics (missing Domain page)', disabled: true },
      { value: 'commerce', label: 'Commerce' },
      { value: 'commerce.customer', label: 'Commerce / Customer' },
      { value: 'growth', label: 'Growth' },
    ]);
  });
});

describe('Global / cross-domain (B10)', () => {
  const domains = [{ id: 'commerce', name: 'Commerce' }];

  it('never shows the global value as a missing Domain page', () => {
    for (const current of ['', 'uncategorized', 'Uncategorized', 'global', undefined]) {
      expect(blockDomainOptions(current, domains)).toEqual([{ value: 'commerce', label: 'Commerce' }]);
      expect(blockDomainSelectValue(current)).toBe('');
    }
    expect(isGlobalBlockDomain('commerce')).toBe(false);
    expect(blockDomainSelectValue('commerce')).toBe('commerce');
    expect(GLOBAL_BLOCK_DOMAIN).toBe('uncategorized');
  });
});

describe('certifyNeedsDomain', () => {
  const domains = [{ id: 'commerce', name: 'Commerce' }];
  const askDraft = (domain = '') => `block "average_order_value_each_store" {
${domain ? `  domain = "${domain}"\n` : ''}  status = "draft"
  query = """SELECT 1 AS value"""
  asked_times = 1
  source_question = "What is the average order value at each store?"
}`;

  it('asks for a Domain before certifying an Ask draft that has none', () => {
    expect(certifyNeedsDomain(askDraft(), '', domains)).toBe(true);
    expect(certifyNeedsDomain(askDraft(), '_drafts', domains)).toBe(true);
    expect(certifyNeedsDomain(askDraft('commerce'), 'commerce', domains)).toBe(false);
    // Global / cross-domain picked on purpose is a choice too.
    expect(certifyNeedsDomain(askDraft(GLOBAL_BLOCK_DOMAIN), GLOBAL_BLOCK_DOMAIN, domains)).toBe(false);
  });

  it('leaves hand-made blocks and projects without Domain pages alone', () => {
    expect(certifyNeedsDomain('block "revenue" {\n  query = """SELECT 1"""\n}', '', domains)).toBe(false);
    expect(certifyNeedsDomain(askDraft(), '', [])).toBe(false);
  });
});
