import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Database, Loader2 } from 'lucide-react';
import { api, DqlApiError } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { Theme } from '../../themes/notebook-theme';
import {
  DBT_DATABASE_PAGE_SIZE,
  databaseObjectDisplayName,
  databaseObjectNamespace,
  dbtInventoryItemToTable,
  isPhysicalDbtInventoryItem,
  mergeDbtAndWarehouseColumns,
  mergeDbtDatabaseObjects,
  type DbtDatabaseObject,
} from './dbt-database-catalog';
import { isSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';

export function DbtDatabaseList({
  t,
  search,
  onInsert,
}: {
  t: Theme;
  search: string;
  onInsert: (text: string) => void;
}) {
  const { dispatch } = useNotebook();
  const [tables, setTables] = useState<DbtDatabaseObject[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadedColumns, setLoadedColumns] = useState<Set<string>>(new Set());
  const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());
  const [columnErrors, setColumnErrors] = useState<Record<string, string>>({});
  const requestVersion = useRef(0);
  const normalizedSearch = search.trim();

  useEffect(() => {
    const version = ++requestVersion.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void api.getDbtModelInventory({
        q: normalizedSearch,
        limit: DBT_DATABASE_PAGE_SIZE,
        physicalOnly: true,
      })
        .then((result) => {
          if (version !== requestVersion.current) return;
          const nextTables = result.items.filter(isPhysicalDbtInventoryItem).map(dbtInventoryItemToTable);
          setTables(nextTables);
          setTotal(result.total);
          setNextCursor(result.nextCursor);
          setExpanded(new Set());
          setLoadedColumns(new Set());
          setColumnErrors({});
          dispatch({ type: 'MERGE_SCHEMA_TABLES', tables: nextTables });
        })
        .catch((reason) => {
          if (version !== requestVersion.current) return;
          setTables([]);
          setTotal(0);
          setNextCursor(null);
          setError(reason instanceof Error ? reason : new Error(String(reason)));
        })
        .finally(() => {
          if (version === requestVersion.current) setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [dispatch, normalizedSearch]);

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    const version = requestVersion.current;
    setLoadingMore(true);
    try {
      const result = await api.getDbtModelInventory({
        q: normalizedSearch,
        cursor: nextCursor,
        limit: DBT_DATABASE_PAGE_SIZE,
        physicalOnly: true,
      });
      if (version !== requestVersion.current) return;
      const incoming = result.items.filter(isPhysicalDbtInventoryItem).map(dbtInventoryItemToTable);
      setTables((current) => mergeDbtDatabaseObjects(current, incoming));
      setTotal(result.total);
      setNextCursor(result.nextCursor);
      dispatch({ type: 'MERGE_SCHEMA_TABLES', tables: incoming });
    } catch (reason) {
      if (version === requestVersion.current) {
        setError(reason instanceof Error ? reason : new Error(String(reason)));
      }
    } finally {
      if (version === requestVersion.current) setLoadingMore(false);
    }
  };

  const toggle = async (table: DbtDatabaseObject) => {
    const opening = !expanded.has(table.dbtUniqueId);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(table.dbtUniqueId);
      else next.delete(table.dbtUniqueId);
      return next;
    });
    if (!opening || loadedColumns.has(table.dbtUniqueId) || loadingColumns.has(table.dbtUniqueId)) return;

    setLoadingColumns((current) => new Set(current).add(table.dbtUniqueId));
    setColumnErrors((current) => {
      const next = { ...current };
      delete next[table.dbtUniqueId];
      return next;
    });
    try {
      const detail = await api.getDbtModelingNode(table.dbtUniqueId);
      const needsWarehouseTypes = detail.columns.length === 0
        || detail.columns.some((column) => !column.type);
      const warehouseColumns = needsWarehouseTypes
        ? await api.describeTable(table.path)
        : [];
      const columns = mergeDbtAndWarehouseColumns(detail, warehouseColumns);
      const updated = { ...table, columns };
      setTables((current) => current.map((candidate) =>
        candidate.dbtUniqueId === table.dbtUniqueId ? updated : candidate));
      setLoadedColumns((current) => new Set(current).add(table.dbtUniqueId));
      dispatch({ type: 'MERGE_SCHEMA_TABLES', tables: [updated] });
    } catch (reason) {
      setColumnErrors((current) => ({
        ...current,
        [table.dbtUniqueId]: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      setLoadingColumns((current) => {
        const next = new Set(current);
        next.delete(table.dbtUniqueId);
        return next;
      });
    }
  };

  if (loading) {
    return <CatalogStatus t={t}><Loader2 size={13} className="dql-spin" /> {isSnowflakeApp() ? 'Loading tables and views…' : 'Loading dbt database objects…'}</CatalogStatus>;
  }

  if (error) {
    return <CatalogError error={error} t={t} />;
  }

  if (tables.length === 0) {
    return (
      <CatalogStatus t={t}>
        {normalizedSearch
          ? `No dbt models or sources match “${normalizedSearch}”.`
          : 'No dbt database objects found. Compile the connected dbt project, then refresh this workspace.'}
      </CatalogStatus>
    );
  }

  return (
    <div>
      <div style={{ padding: '7px 10px', borderBottom: `1px solid ${t.cellBorder}`, color: t.textMuted, fontSize: 10.5 }}>
        {isSnowflakeApp()
          ? `Showing ${tables.length.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'table or view' : 'tables and views'}`
          : <>dbt scope · showing {tables.length.toLocaleString()} of {total.toLocaleString()} object{total === 1 ? '' : 's'}</>}
      </div>
      {tables.map((table) => {
        const open = expanded.has(table.dbtUniqueId);
        const columnsLoading = loadingColumns.has(table.dbtUniqueId);
        const columnError = columnErrors[table.dbtUniqueId];
        const displayName = databaseObjectDisplayName(table.path);
        const namespace = databaseObjectNamespace(table.path);
        return (
          <div key={table.dbtUniqueId}>
            <div style={{ ...rowStyle(t), alignItems: 'flex-start' }}>
              <button
                type="button"
                onClick={() => void toggle(table)}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${displayName}`}
                title={open ? 'Collapse columns' : 'Load columns'}
                style={iconButtonStyle(t)}
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <button
                type="button"
                onClick={() => onInsert(`SELECT * FROM ${table.path} LIMIT 100`)}
                title={`Insert a bounded SELECT from ${table.path}`}
                style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: t.textPrimary, textAlign: 'left', display: 'grid', gap: 2, padding: 0, fontFamily: t.font }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <Database size={12.5} color={t.accent} style={{ flexShrink: 0 }} />
                  <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontFamily: t.fontMono }}>{displayName}</strong>
                  <span style={{ fontSize: 8.5, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>{table.dbtResourceType === 'warehouse' ? 'table' : table.dbtResourceType}</span>
                  {loadedColumns.has(table.dbtUniqueId) ? <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{table.columns.length}</span> : null}
                </span>
                {namespace ? <span style={{ paddingLeft: 19, color: t.textMuted, fontSize: 9.5, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{namespace}</span> : null}
              </button>
            </div>
            {open ? (
              <div>
                {columnsLoading ? <CatalogStatus t={t} compact><Loader2 size={11} className="dql-spin" /> Loading columns…</CatalogStatus> : null}
                {!columnsLoading && columnError ? <CatalogStatus t={t} compact>Columns unavailable. The relation can still be inserted and queried.</CatalogStatus> : null}
                {!columnsLoading && !columnError && loadedColumns.has(table.dbtUniqueId) && table.columns.length === 0
                  ? <CatalogStatus t={t} compact>{isSnowflakeApp() ? 'No columns are visible to this app for this table.' : 'No columns are documented in dbt or visible from the selected connection.'}</CatalogStatus>
                  : null}
                {!columnsLoading && table.columns.map((column) => (
                  <button
                    key={column.name}
                    type="button"
                    onClick={() => onInsert(column.name)}
                    title={`Insert column ${column.name}`}
                    style={{ ...rowStyle(t), paddingLeft: 34, gap: 7 }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontFamily: t.fontMono, color: t.textSecondary }}>{column.name}</span>
                    <span style={{ fontSize: 9.5, color: t.textMuted, flexShrink: 0, fontFamily: t.fontMono }}>{column.type || 'unknown'}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {nextCursor !== null ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          style={{ width: 'calc(100% - 20px)', margin: '9px 10px 11px', padding: '7px 9px', borderRadius: 6, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textSecondary, cursor: loadingMore ? 'wait' : 'pointer', fontSize: 10.5, fontFamily: t.font }}
        >
          {loadingMore ? 'Loading…' : `Load ${Math.min(DBT_DATABASE_PAGE_SIZE, total - tables.length).toLocaleString()} more`}
        </button>
      ) : null}
      <style>{`.dql-spin { animation: dql-catalog-spin .8s linear infinite; } @keyframes dql-catalog-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function CatalogError({ error, t }: { error: Error; t: Theme }) {
  const apiError = error instanceof DqlApiError ? error : null;
  const message = apiError?.code === 'DBT_FIRST_NOT_ENABLED'
    ? 'Connect and apply a dbt project in Settings to browse its database objects.'
    : apiError?.code === 'DBT_MANIFEST_NOT_FOUND'
      ? 'The connected dbt manifest is missing. Run dbt parse or dbt build, then refresh.'
      : 'The dbt database catalog could not be loaded. Refresh after checking the dbt project setup.';
  return <CatalogStatus t={t}>{message}</CatalogStatus>;
}

function CatalogStatus({
  t,
  compact = false,
  children,
}: {
  t: Theme;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: compact ? '6px 12px 6px 34px' : '16px 12px', fontSize: compact ? 10 : 11.5, color: t.textMuted, textAlign: compact ? 'left' : 'center', display: 'flex', alignItems: 'center', justifyContent: compact ? 'flex-start' : 'center', gap: 6 }}>
      {children}
    </div>
  );
}

const rowStyle = (t: Theme): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0, boxSizing: 'border-box',
  padding: '7px 10px', border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
  background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: t.font, color: t.textPrimary,
});

const iconButtonStyle = (t: Theme): React.CSSProperties => ({
  border: 'none', background: 'transparent', cursor: 'pointer', color: t.textMuted,
  display: 'flex', padding: '1px 0 0', flexShrink: 0,
});
