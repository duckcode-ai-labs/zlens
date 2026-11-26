/**
 * "Check faster" (onboarding design P7, decision D6): the background data
 * checks can run on a larger size of the app's own warehouse, when the person
 * chooses it with the estimate shown first, and the warehouse goes back to
 * X-Small as soon as they end (finished, stopped or failed), and at the next
 * start if ZLens stopped in between.
 *
 * Only the app's own warehouse is ever resized: `<app>_WH`, which the app's
 * setup script creates, so the app owns it and needs no new privilege. Any
 * other warehouse (a laptop's, one a person configured) is never touched. If
 * Snowflake refuses the resize, the checks run on X-Small and say why.
 */
export type CheckWarehouseSize = 'XSMALL' | 'SMALL' | 'MEDIUM';

export const CHECK_WAREHOUSE_SIZES: readonly CheckWarehouseSize[] = ['XSMALL', 'SMALL', 'MEDIUM'];

/** Credits an hour of each size (Snowflake's standard warehouse). */
export const CREDITS_PER_HOUR: Record<CheckWarehouseSize, number> = { XSMALL: 1, SMALL: 2, MEDIUM: 4 };

export function isCheckWarehouseSize(value: unknown): value is CheckWarehouseSize {
  return typeof value === 'string' && (CHECK_WAREHOUSE_SIZES as readonly string[]).includes(value);
}

const plainName = (value: string) => value.trim().replace(/^"|"$/g, '');

/** The app's own warehouse, when the configured one is it; else null (never resized). */
export function appOwnWarehouse(appName: string | undefined, configured: string | undefined): string | null {
  if (!appName || !configured) return null;
  const own = `${plainName(appName)}_WH`;
  const name = plainName(configured);
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.toUpperCase() === own.toUpperCase() ? name.toUpperCase() : null;
}

export function resizeStatement(warehouse: string, size: CheckWarehouseSize): string {
  return `ALTER WAREHOUSE IDENTIFIER('${warehouse.replace(/'/g, "''")}') SET WAREHOUSE_SIZE = '${size}'`;
}

export class AppWarehouseSizer {
  constructor(private readonly options: {
    warehouse: string;
    query: (sql: string) => Promise<unknown>;
    warn?: (message: string) => void;
  }) {}

  get warehouse(): string {
    return this.options.warehouse;
  }

  /** Resize for the checks; `{ ok: false, error }` when Snowflake refuses (the checks then run on X-Small). */
  async resize(size: CheckWarehouseSize): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.options.query(resizeStatement(this.options.warehouse, size));
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : String(error);
      (this.options.warn ?? console.warn)(`[zlens] Could not resize ${this.options.warehouse} for the checks (${message}); they run on X-Small.`);
      return { ok: false, error: message };
    }
  }

  /** Back to X-Small. Best effort: a failure is said, never thrown. */
  async restore(): Promise<boolean> {
    try {
      await this.options.query(resizeStatement(this.options.warehouse, 'XSMALL'));
      return true;
    } catch (error) {
      (this.options.warn ?? console.warn)(`[zlens] Could not size ${this.options.warehouse} back to X-Small (${error instanceof Error ? error.message : String(error)}). An admin can run ALTER WAREHOUSE ${this.options.warehouse} SET WAREHOUSE_SIZE = XSMALL.`);
      return false;
    }
  }
}
