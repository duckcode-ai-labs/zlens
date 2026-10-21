import { describe, expect, it } from 'vitest';
import { GLOBAL_BLOCK_DOMAIN, blockDomainOptions, blockDomainSelectValue, isGlobalBlockDomain } from './domain-options';

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
