import { describe, expect, it } from 'vitest';
import { appSourceIdsUsedByTiles, appSourcesNotUsedByTiles } from './app-data-sources.js';

describe('App data sources used by tiles (design D4)', () => {
  const sources = [
    { id: 'app:block:orders', kind: 'block', sourceRef: 'blocks/orders.dql', executionRef: 'blocks/orders.dql' },
    { id: 'legacy', kind: 'block', sourceRef: 'top_customers' },
    { id: 'semantic:margin', kind: 'governed_semantic', sourceRef: 'finance.margin' },
    { id: 'draft:analysis', kind: 'review_dql', sourceRef: 'local:analysis-1' },
    { id: 'app:block:unused', kind: 'block', sourceRef: 'blocks/unused.dql' },
    { id: 'ask:1', kind: 'text', sourceRef: 'ask:1' },
  ];
  const pages = [{
    layout: {
      items: [
        { sourceId: 'app:block:orders' },
        { block: { blockId: 'top_customers' } },
        { semantic: { id: 'finance.margin' } },
        { draftAnalysis: { ref: 'analysis-1' } },
        {},
      ],
    },
  }];

  it('matches tiles by source id, block, semantic and draft references', () => {
    expect([...appSourceIdsUsedByTiles({ sources, pages })].sort()).toEqual(['app:block:orders', 'draft:analysis', 'legacy', 'semantic:margin']);
  });

  it('lists connected data that no tile uses, without page text', () => {
    expect(appSourcesNotUsedByTiles({ sources, pages }).map((source) => source.id)).toEqual(['app:block:unused']);
    expect(appSourcesNotUsedByTiles({ sources, pages: [] }).map((source) => source.id)).toHaveLength(5);
  });
});
