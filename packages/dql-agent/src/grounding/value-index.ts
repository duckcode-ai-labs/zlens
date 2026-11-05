import { createHash } from 'node:crypto';
import { tableName } from '@zlens/core';

export interface ValueIndexColumn {
  name: string;
  type?: string;
  sampleValues?: string[];
}

export interface ValueIndexTable {
  relation: string;
  schema?: string;
  name?: string;
  source?: string;
  columns: ValueIndexColumn[];
}

export interface ValueIndexSnapshot {
  source?: string;
  capturedAt?: string;
  tables: ValueIndexTable[];
}

export interface RuntimeValueIndexEntry {
  valueKey: string;
  relation: string;
  schema?: string;
  tableName?: string;
  columnName: string;
  columnType?: string;
  value: string;
  normalizedValue: string;
  source?: string;
  capturedAt: string;
}

export function buildRuntimeValueIndex(snapshot: ValueIndexSnapshot): RuntimeValueIndexEntry[] {
  const capturedAt = snapshot.capturedAt ?? new Date().toISOString();
  const byKey = new Map<string, RuntimeValueIndexEntry>();
  for (const table of snapshot.tables ?? []) {
    const relation = table.relation?.trim();
    if (!relation) continue;
    for (const column of table.columns ?? []) {
      if (!isIndexableValueColumn(column)) continue;
      for (const rawValue of column.sampleValues ?? []) {
        const value = cleanValueIndexLiteral(rawValue);
        if (!value) continue;
        const normalizedValue = normalizeValueIndexText(value);
        if (!normalizedValue) continue;
        const valueKey = `runtime:value:${stableValueHash([relation, column.name, normalizedValue].join('\u0000'))}`;
        if (byKey.has(valueKey)) continue;
        byKey.set(valueKey, {
          valueKey,
          relation,
          schema: table.schema,
          tableName: table.name ?? (tableName(relation) || relation),
          columnName: column.name,
          columnType: column.type,
          value,
          normalizedValue,
          source: snapshot.source ?? table.source,
          capturedAt,
        });
      }
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.relation.localeCompare(b.relation) ||
    a.columnName.localeCompare(b.columnName) ||
    a.normalizedValue.localeCompare(b.normalizedValue)
  ).slice(0, 5000);
}

export function normalizeValueIndexText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}@. ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isIndexableValueColumn(column: ValueIndexColumn): boolean {
  const name = column.name?.toLowerCase() ?? '';
  if (!name || /\b(password|secret|token|credential|hash|salt)\b/.test(name)) return false;
  const type = column.type?.toLowerCase() ?? '';
  return !type || /\b(char|character|clob|email|string|text|uuid|varchar)\b/.test(type);
}

function cleanValueIndexLiteral(value: string): string {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2 || clean.length > 120) return '';
  if (/^\d+(?:\.\d+)?$/.test(clean)) return '';
  return clean;
}

function stableValueHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}
