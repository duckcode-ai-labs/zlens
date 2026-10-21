import { describe, expect, it } from 'vitest';
import type { Domain } from '../../store/types';
import { savedBlockGitPath } from './artifact-location';

describe('Save as Block path preview', () => {
  const domains: Domain[] = [
    { id: 'commerce', name: 'Commerce', sourcePath: 'domains/commerce/domain.dql' },
  ];

  it('previews the file the server writes inside the domain package', () => {
    expect(savedBlockGitPath(domains, 'commerce', 'orders_by_store')).toBe(
      'domains/commerce/blocks/orders_by_store.dql',
    );
    expect(savedBlockGitPath(domains, 'commerce', 'Orders by store')).toBe(
      'domains/commerce/blocks/orders-by-store.dql',
    );
  });

  it('keeps a block without a declared domain package under blocks/', () => {
    expect(savedBlockGitPath(domains, '', 'new_block')).toBe('blocks/new_block.dql');
    expect(savedBlockGitPath(domains, 'finance', 'new_block')).toBe('blocks/finance/new_block.dql');
  });
});
