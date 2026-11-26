import { describe, expect, it } from 'vitest';
import { AppWarehouseSizer, appOwnWarehouse, isCheckWarehouseSize, resizeStatement } from './snowflake-app-warehouse.js';

/** Onboarding design P7, decision D6: "Check faster" resizes only the app's own warehouse, and always back. */
describe('Check faster on the app\'s own warehouse', () => {
  it('resizes only <app>_WH, never another warehouse', () => {
    expect(appOwnWarehouse('ZLENS_APP', 'ZLENS_APP_WH')).toBe('ZLENS_APP_WH');
    expect(appOwnWarehouse('zlens_app', '"ZLENS_APP_WH"')).toBe('ZLENS_APP_WH');
    expect(appOwnWarehouse('ZLENS_APP', 'ANALYTICS_WH')).toBeNull();
    expect(appOwnWarehouse(undefined, 'ZLENS_APP_WH')).toBeNull();
    expect(appOwnWarehouse('ZLENS_APP', "ZLENS_APP_WH'; DROP")).toBeNull();
    expect(resizeStatement('ZLENS_APP_WH', 'SMALL')).toBe("ALTER WAREHOUSE IDENTIFIER('ZLENS_APP_WH') SET WAREHOUSE_SIZE = 'SMALL'");
    expect(isCheckWarehouseSize('MEDIUM')).toBe(true);
    expect(isCheckWarehouseSize('X4LARGE')).toBe(false);
  });

  it('says a refusal instead of failing, and sizes back to X-Small', async () => {
    const statements: string[] = [];
    let refuse = false;
    const warnings: string[] = [];
    const sizer = new AppWarehouseSizer({ warehouse: 'ZLENS_APP_WH', query: async (sql) => { statements.push(sql); if (refuse) throw new Error('Insufficient privileges to operate on warehouse'); }, warn: (message) => warnings.push(message) });
    expect(await sizer.resize('MEDIUM')).toEqual({ ok: true });
    expect(await sizer.restore()).toBe(true);
    expect(statements).toEqual(["ALTER WAREHOUSE IDENTIFIER('ZLENS_APP_WH') SET WAREHOUSE_SIZE = 'MEDIUM'", "ALTER WAREHOUSE IDENTIFIER('ZLENS_APP_WH') SET WAREHOUSE_SIZE = 'XSMALL'"]);
    refuse = true;
    expect(await sizer.resize('SMALL')).toEqual({ ok: false, error: 'Insufficient privileges to operate on warehouse' });
    expect(warnings[0]).toContain('they run on X-Small');
  });
});
