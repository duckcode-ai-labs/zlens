import { describe, expect, it } from 'vitest';
import type { WarehouseSetupStatus } from '../../api/client';
import { stagedReadLine } from './StagedReadCard';

const setup = (read: NonNullable<WarehouseSetupStatus['setup']>['read']): NonNullable<WarehouseSetupStatus['setup']> => ({
  version: 1, connectionId: 'default', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }], check: true, read,
});

describe('Read these tables (onboarding design P3)', () => {
  it('follows the read with its counts, then says ready to ask', () => {
    expect(stagedReadLine(null)).toBeNull();
    const operation = { id: 'op', type: 'warehouse-read', scope: 's', status: 'running' as const, phase: 'names', progress: 10, message: 'Reading names in SALES: 420 of 1,240 tables so far (statement 1 of 1) · 12 s', cancellable: true, createdAt: '', updatedAt: '' };
    expect(stagedReadLine({ stage: 'reading', setup: setup({ state: 'running' }), operation })).toEqual({ tone: 'info', text: operation.message });
    expect(stagedReadLine({ stage: 'checking', setup: setup({ state: 'done', relations: 1240 }), operation: null }))
      .toEqual({ tone: 'success', text: 'Read 1,240 tables: names, types, comments, keys. Ready to ask.' });
    expect(stagedReadLine({ stage: 'failed', setup: setup({ state: 'failed', error: 'no access' }), operation: null }))
      .toEqual({ tone: 'caution', text: 'Could not read the chosen schemas: no access' });
    expect(stagedReadLine({ stage: 'stopped', setup: setup({ state: 'stopped' }), operation: null })?.text).toBe('Reading was stopped. Nothing was read.');
  });
});
