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

  it('says where the setup is, with numbers and the time, and offers Stop while it runs (onboarding P2)', () => {
    const operation = {
      id: 'op_1', type: 'warehouse-setup', scope: 'warehouse-setup:NBA', status: 'running' as const, phase: 'names', progress: 18,
      message: 'Reading names in NBA: 420 tables so far (statement 1 of 1) · 12 s', cancellable: true, createdAt: '', updatedAt: '',
    };
    expect(snowflakeAppSetupMessage({ managed: true, state: 'running', database: 'NBA', operation })).toEqual({
      tone: 'info',
      text: 'Setting up ZLens. Reading names in NBA: 420 tables so far (statement 1 of 1) · 12 s',
      action: 'stop',
    });
    // Before its first phase, the plain words, still with Stop.
    expect(snowflakeAppSetupMessage({ managed: true, state: 'running', database: 'NBA', operation: { ...operation, phase: 'starting' } })?.action).toBe('stop');
  });

  it('says a stopped setup drafted nothing and offers to start again', () => {
    expect(snowflakeAppSetupMessage({ managed: true, state: 'stopped', database: 'NBA' }))
      .toEqual({ tone: 'caution', text: 'Setup from NBA was stopped. Nothing was drafted.', action: 'start' });
  });

  it('asks the person to choose the data before anything is read (onboarding P3)', () => {
    expect(snowflakeAppSetupMessage({ managed: true, state: 'idle', stage: 'choose' }))
      .toEqual({ tone: 'info', text: 'Choose the data ZLens reads to start asking.', action: 'choose' });
  });

  it('says ready to ask while the checks run, with their counts and Stop; offers to check when they are not running', () => {
    const operation = {
      id: 'op_2', type: 'warehouse-check', scope: 'warehouse-setup:default', status: 'running' as const, phase: 'check', progress: 55,
      message: 'Checking keys and joins on the data in SALES · 1 min 05 s', cancellable: true, createdAt: '', updatedAt: '',
    };
    expect(snowflakeAppSetupMessage({ managed: true, state: 'ready', database: 'SALES', operation })).toEqual({
      tone: 'info',
      text: 'Ready to ask. Checking keys and joins on the data in SALES · 1 min 05 s. Answers get better as the checks land.',
      action: 'stop',
    });
    expect(snowflakeAppSetupMessage({ managed: true, state: 'ready', database: 'SALES', operation: null })?.action).toBe('check');
    expect(snowflakeAppSetupMessage({ managed: true, state: 'ready', database: 'SALES', checks: 'stopped', operation: null })?.text)
      .toBe('Ready to ask. The data checks were stopped: answers stay labeled AI-generated until they run and you review the drafts.');
    expect(snowflakeAppSetupMessage({ managed: true, state: 'ready', database: 'SALES', checks: 'off', operation: null })?.text).toMatch(/^Ready to ask\. The data checks are off:/);
    expect(snowflakeAppSetupMessage({ managed: true, state: 'ready', database: 'SALES', error: 'warehouse suspended' }))
      .toEqual({ tone: 'caution', text: 'Ready to ask. The data checks did not finish: warehouse suspended', action: 'check' });
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

  it('says Ask is not ready in place of "Ready to ask." while Ask\'s Snowflake Cortex is not set up (fix plan risk 3)', () => {
    const askReadiness = { state: 'region' as const, headline: 'Ask is not ready: Snowflake Cortex offers no Claude model to your account in its region.', checkedAt: '2026-11-26T18:00:00.000Z' };
    expect(snowflakeAppSetupMessage({ managed: true, state: 'ready', database: 'NBA', checks: 'off', askReadiness })).toEqual({
      tone: 'caution',
      text: 'Ask is not ready: Snowflake Cortex offers no Claude model to your account in its region. The data checks are off: answers stay labeled AI-generated until they run and you review the drafts.',
      action: 'check',
    });
    // Ready, or not checked yet: as before.
    expect(snowflakeAppSetupMessage({ managed: true, state: 'ready', database: 'NBA', checks: 'off', askReadiness: { state: 'ready', headline: 'Ask is ready: it uses claude-sonnet-5-5 through Snowflake Cortex.', checkedAt: '' } })?.text)
      .toMatch(/^Ready to ask\. The data checks are off/);
    expect(snowflakeAppSetupMessage({ managed: true, state: 'ready', database: 'NBA', checks: 'off', askReadiness: null })).toMatchObject({ tone: 'info' });
  });
});
