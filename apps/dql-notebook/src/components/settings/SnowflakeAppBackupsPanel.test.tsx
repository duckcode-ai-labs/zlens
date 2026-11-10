import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { themes } from '../../themes/notebook-theme';
import { snowflakeAppRestoreOffer } from '../shell/SnowflakeAppSetupBanner';
import { SnowflakeAppBackupsPanel, backupLabel, restoreLine, stageSetupLines } from './SnowflakeAppBackupsPanel';
import type { SnowflakeAppBackups } from '../../api/client';

vi.mock('../../api/client', () => ({ api: {} }));

const base: SnowflakeAppBackups = { managed: true, app: 'ZLENS_APP', running: false, projectIsEmpty: false, snapshots: [], stage: null, exports: [] };

describe('Settings » Backups in the ZLens app for Snowflake', () => {
  it('gives the admin the exact lines to restore a snapshot and to set up a stage of their own', () => {
    expect(restoreLine('ZLENS_APP', 'ZLENS_BACKUP_20261109_220000')).toBe("CALL ZLENS_APP.app_public.restore_backup('ZLENS_BACKUP_20261109_220000');");
    expect(stageSetupLines('ZLENS_APP')).toContain('GRANT READ, WRITE ON STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS TO APPLICATION ZLENS_APP;');
    expect(backupLabel('ZLENS_BACKUP_20261109_2200', 'not a date')).toBe('2026-11-09 22:00 UTC');
  });

  it('says when there are no backups yet, and how to keep a copy that outlives the app', () => {
    const html = renderToStaticMarkup(<SnowflakeAppBackupsPanel t={themes.paper} initial={base} />);
    expect(html).toContain('No backups yet');
    expect(html).toContain('Back up now');
    expect(html).toContain('Stage for ZLens backups');
    expect(html).toContain('GRANT READ, WRITE ON STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS TO APPLICATION ZLENS_APP;');
  });

  it('lists the snapshots and the copies, with the restore line for the newest snapshot', () => {
    const html = renderToStaticMarkup(<SnowflakeAppBackupsPanel t={themes.paper} initial={{
      ...base,
      snapshots: [{ name: 'ZLENS_BACKUP_20261109_220000', state: 'CREATED', createdOn: '' }],
      stage: 'MY_DB.TOOLS.ZLENS_BACKUPS',
      exports: [{ file: 'zlens-zlens_app-20261109_220000.tar.gz', size: 100, lastModified: '' }],
    }} />);
    expect(html).toContain('restore_backup(&#x27;ZLENS_BACKUP_20261109_220000&#x27;)');
    expect(html).toContain('zlens-zlens_app-20261109_220000.tar.gz');
    expect(html).toContain('MY_DB.TOOLS.ZLENS_BACKUPS');
  });

  it('offers to restore the newest copy only on an empty project with copies in the stage', () => {
    const copies = { ...base, stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', exports: [{ file: 'zlens-zlens_app-20261109_220000.tar.gz', size: 1, lastModified: '' }] };
    expect(snowflakeAppRestoreOffer({ ...copies, projectIsEmpty: true })).toEqual({ text: 'A copy of your ZLens projects from 2026-11-09 is in MY_DB.TOOLS.ZLENS_BACKUPS.', file: 'zlens-zlens_app-20261109_220000.tar.gz' });
    expect(snowflakeAppRestoreOffer({ ...copies, projectIsEmpty: false })).toBeNull();
    expect(snowflakeAppRestoreOffer({ ...copies, projectIsEmpty: true, exports: [] })).toBeNull();
    expect(snowflakeAppRestoreOffer(null)).toBeNull();
  });
});
