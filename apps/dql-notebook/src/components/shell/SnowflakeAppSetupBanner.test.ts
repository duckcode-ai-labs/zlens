import { describe, expect, it } from 'vitest';
import { snowflakeAppSetupMessage } from './SnowflakeAppSetupBanner';

describe('the Snowflake app setup strip', () => {
  it('says nothing outside the Snowflake app', () => {
    expect(snowflakeAppSetupMessage(null)).toBeNull();
    expect(snowflakeAppSetupMessage({ managed: false, state: 'idle' })).toBeNull();
  });

  it('says ZLens is reading the tables while it sets up', () => {
    expect(snowflakeAppSetupMessage({ managed: true, state: 'running', database: 'NBA' })?.text)
      .toBe('ZLens is reading the tables in NBA and drafting your models. This takes a minute or two.');
  });

  it('points to the drafts waiting for review', () => {
    const message = snowflakeAppSetupMessage({
      managed: true,
      state: 'done',
      database: 'NBA',
      relations: 18,
      drafted: 17,
      waitingDraft: { proposalId: 'p1', createdAt: '2026-11-09T00:00:00Z', models: 17, joins: 6, domains: ['NBA'], stale: false },
    });
    expect(message).toEqual({
      tone: 'info',
      text: 'ZLens read 18 tables and views in NBA and drafted 17 models and 6 joins. Nothing is saved until you review them.',
      action: 'review',
      key: 'p1',
    });
  });

  it('goes away once the drafts are reviewed', () => {
    expect(snowflakeAppSetupMessage({ managed: true, state: 'done', database: 'NBA', relations: 18, waitingDraft: null })).toBeNull();
  });

  it('offers to try again when setup failed', () => {
    expect(snowflakeAppSetupMessage({ managed: true, state: 'failed', database: 'NBA', error: 'the app can see no schemas there. Grant it USAGE on the schemas to read.' }))
      .toEqual({ tone: 'caution', text: 'ZLens could not read the tables in NBA: the app can see no schemas there. Grant it USAGE on the schemas to read.', action: 'retry' });
  });
});
