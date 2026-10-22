import { describe, expect, it } from 'vitest';
import { retiredTileNotice } from './tile-retirement';

describe('a tile bound to a retired block tells its author', () => {
  it('names the replacement and the date', () => {
    expect(retiredTileNotice({ tileId: 'kpi', status: 'ok', blockId: 'Claims Summary', certificationStatus: 'deprecated', retirement: { replacedBy: 'Claims Dataset', deprecatedOn: '2026-09-30' } })).toEqual({
      label: 'Retired — replaced by Claims Dataset',
      detail: 'Claims Summary was retired on 2026-09-30. Point this tile at Claims Dataset before you publish again.',
    });
  });
  it('says nothing for a tile whose block is not retired', () => {
    expect(retiredTileNotice({ tileId: 'kpi', status: 'ok', blockId: 'Claims Dataset', certificationStatus: 'certified' })).toBeUndefined();
    expect(retiredTileNotice(undefined)).toBeUndefined();
  });
});
