import { certifiedSourceState } from '@zlens/core';
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';

/**
 * The few fields of a saved query (`.dql`) History compares and names, read without the full parser: History
 * reads old versions, which may not parse with today's rules, and must never fail because of one.
 */
export interface SavedQueryFields {
  name: string;
  status: string;
  description: string;
  owner: string;
  domain: string;
  tags: string[];
  chart: string;
  sql: string;
  /** The question an automatic Ask draft was saved from. */
  sourceQuestion: string;
}

const unescape = (value: string) => value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

function stringField(source: string, key: string): string {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(source);
  return match ? unescape(match[1]!) : '';
}

export function readSavedQueryFields(source: string): SavedQueryFields {
  const tags = /^\s*tags\s*=\s*\[([^\]]*)\]/m.exec(source)?.[1];
  const query = /\bquery\s*=\s*"""([\s\S]*?)"""/.exec(source)?.[1];
  const chart = /\bvisualization\s*\{[\s\S]*?\bchart\s*=\s*"([^"]*)"/.exec(source)?.[1] ?? '';
  const question = stringField(source, 'source_question')
    || unescape(/\bexamples\s*=\s*\[\s*\{\s*question\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(source)?.[1] ?? '');
  return {
    name: /^\s*block\s+"([^"]+)"/m.exec(source)?.[1] ?? '',
    status: (stringField(source, 'status') || 'draft').toLowerCase(),
    description: stringField(source, 'description'),
    owner: stringField(source, 'owner'),
    domain: stringField(source, 'domain'),
    tags: tags ? (tags.match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)) : [],
    chart,
    sql: query !== undefined ? dedent(query) : '',
    sourceQuestion: question,
  };
}

/** The SQL as written, without the indentation the block adds. */
function dedent(text: string): string {
  const lines = text.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const indents = lines.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut)).join('\n');
}

/**
 * Whether this version is certified: the file says certified AND its receipt was made for exactly this source.
 * A saved query edited after it was certified is not (Saving through ZLens writes it as a draft anyway).
 */
export function isCertifiedVersion(source: string, companion: string | null): boolean {
  return readSavedQueryFields(source).status === 'certified' && certifiedSourceState(source, companion) === 'matches';
}

/** What the receipt in a companion YAML says, for a header card: who, when, and the old-report line. */
export function receiptSummary(companion: string | null): { certifiedBy?: string; certifiedAt?: string; oldReport?: string } {
  if (!companion) return {};
  let receipt: { certifiedBy?: unknown; certifiedByName?: unknown; certifiedAt?: unknown; checks?: unknown } | undefined;
  try {
    receipt = (loadYaml(companion, { schema: JSON_SCHEMA }) as { certification?: typeof receipt } | null)?.certification;
  } catch {
    return {};
  }
  if (!receipt || typeof receipt !== 'object') return {};
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const by = text(receipt.certifiedByName) ?? text(receipt.certifiedBy);
  const at = text(receipt.certifiedAt);
  const oldReport = (Array.isArray(receipt.checks) ? receipt.checks : [])
    .map(text)
    .find((check): check is string => Boolean(check && /^(Matches|Differs from|Not proven against)\b/.test(check)));
  return { ...(by ? { certifiedBy: by } : {}), ...(at ? { certifiedAt: at } : {}), ...(oldReport ? { oldReport } : {}) };
}

/** A draft written as a draft: any status line becomes `draft` (or one is added). */
export function asDraftSource(source: string): string {
  if (/^\s*status\s*=\s*"[^"]*"/m.test(source)) return source.replace(/^(\s*status\s*=\s*)"[^"]*"/m, '$1"draft"');
  return source.replace(/(\bblock\s+"[^"]+"\s*\{)/, '$1\n  status = "draft"');
}

export interface FieldChange {
  field: 'name' | 'description' | 'owner' | 'domain' | 'tags' | 'chart' | 'status';
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

const LABELS: Record<FieldChange['field'], string> = {
  name: 'Name',
  description: 'Description',
  owner: 'Owner',
  domain: 'Domain',
  tags: 'Tags',
  chart: 'Chart',
  status: 'Status',
};

export function compareSavedQueryFields(before: SavedQueryFields | null, after: SavedQueryFields | null): FieldChange[] {
  const value = (fields: SavedQueryFields | null, field: FieldChange['field']) => {
    if (!fields) return '';
    return field === 'tags' ? fields.tags.join(', ') : fields[field];
  };
  return (Object.keys(LABELS) as Array<FieldChange['field']>).map((field) => {
    const a = value(before, field);
    const b = value(after, field);
    return { field, label: LABELS[field], before: a, after: b, changed: a !== b };
  });
}
