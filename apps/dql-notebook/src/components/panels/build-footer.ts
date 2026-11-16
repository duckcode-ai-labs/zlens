import { semanticLayerName } from '../../snowflake-app/snowflake-app-words';

/**
 * The Build sidebar status line (Notebooks and Blocks). Each count says what it
 * counts: dbt models from the dbt artifacts, warehouse tables from the schema
 * the connection reported (shown only once that schema has been read), metrics
 * from the semantic layer. The old line printed "0 tables" whenever the schema
 * had not been opened yet, on projects whose data and lineage worked.
 */
export function buildCatalogFooter(input: {
  provider?: string | null;
  dbtModels?: number;
  warehouseTables?: number;
  metrics: number;
  /** The ZLens app for Snowflake: its own semantic layer is "Semantic layer", never "DQL semantic layer". */
  snowflakeApp?: boolean;
}): string {
  const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
  // `dql` is the native semantic layer: the DQL semantic-layer files in this project.
  const provider = input.provider === 'dql'
    ? semanticLayerName(Boolean(input.snowflakeApp))
    : input.provider
      ? input.provider
      : 'dbt';
  return [
    `${provider} synced`,
    typeof input.dbtModels === 'number' && input.dbtModels > 0 ? plural(input.dbtModels, 'dbt model') : null,
    typeof input.warehouseTables === 'number' && input.warehouseTables > 0 ? plural(input.warehouseTables, 'warehouse table') : null,
    plural(input.metrics, 'metric'),
  ].filter(Boolean).join(' · ');
}
