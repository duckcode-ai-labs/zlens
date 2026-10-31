import { NodeKind, type BlockDeclNode, type BlockParamEntry, type BlockParamType, type ExpressionNode } from '../ast/index.js';

export type BlockParameterPolicy = 'dynamic' | 'static' | 'business' | 'derived' | 'optional' | 'ambiguous_review_required';

export type BlockParameterBinding =
  | { kind: 'sql_value' }
  | { kind: 'semantic_filter'; field: string; operator: 'equals' | 'in' | 'gte' | 'lte' }
  | { kind: 'limit' };

export interface BlockParameterDefinition {
  name: string;
  type: BlockParamType;
  required: boolean;
  default?: unknown;
  policy: BlockParameterPolicy;
  binding?: BlockParameterBinding;
}

export interface ResolvedBlockParameter {
  name: string;
  value: unknown;
  source: 'explicit' | 'default';
}

export interface BlockParameterResolution {
  values: Record<string, unknown>;
  resolved: ResolvedBlockParameter[];
  unresolved: string[];
  errors: string[];
}

export interface SemanticRuntimeParameterBindings {
  filters: Array<{ dimension: string; operator: string; values: string[] }>;
  limit?: number;
}

/**
 * Converts the compact AST parameter shape into a durable runtime contract.
 * Legacy parameters continue to work: their type is inferred from the default
 * and their policy comes from the existing parameterPolicy section.
 */
export function blockParameterDefinitions(block: BlockDeclNode): BlockParameterDefinition[] {
  const policies = new Map((block.parameterPolicy ?? []).map((entry) => [entry.name, normalizePolicy(entry.policy)]));
  const interpolationNames = new Set(block.query?.interpolations.map((entry) => entry.variableName) ?? []);
  const bindings = new Map((block.filterBindings ?? []).map((entry) => [entry.filter, entry.binding]));
  const seen = new Set<string>();

  return (block.params?.params ?? []).flatMap((entry) => {
    if (seen.has(entry.name)) return [];
    seen.add(entry.name);
    const defaultValue = entry.initializer ? evaluateBlockParameterExpression(entry.initializer) : undefined;
    const type = entry.paramType ?? inferBlockParameterType(defaultValue);
    const policy = policies.get(entry.name) ?? (entry.initializer ? 'dynamic' : 'dynamic');
    const binding = inferBinding({ entry, interpolationNames, filterBinding: bindings.get(entry.name), blockType: block.blockType });
    return [{
      name: entry.name,
      type,
      required: !entry.initializer,
      ...(entry.initializer ? { default: defaultValue } : {}),
      policy,
      ...(binding ? { binding } : {}),
    }];
  });
}

/** Resolve UI/API overrides without permitting SQL fragments or structural changes. */
export function resolveBlockParameterValues(
  definitions: BlockParameterDefinition[],
  overrides: Record<string, unknown> = {},
): BlockParameterResolution {
  const values: Record<string, unknown> = {};
  const resolved: ResolvedBlockParameter[] = [];
  const unresolved: string[] = [];
  const errors: string[] = [];

  for (const definition of definitions) {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, definition.name);
    const raw = hasOverride ? overrides[definition.name] : definition.default;
    if (raw === undefined || raw === null || raw === '') {
      if (definition.required) unresolved.push(definition.name);
      continue;
    }
    const coerced = coerceParameterValue(raw, definition.type);
    if (!coerced.ok) {
      errors.push(`Parameter "${definition.name}" must be ${definition.type}.`);
      continue;
    }
    values[definition.name] = coerced.value;
    resolved.push({ name: definition.name, value: coerced.value, source: hasOverride ? 'explicit' : 'default' });
  }

  return { values, resolved, unresolved, errors };
}

/**
 * Lowers a semantic block's typed runtime values into the semantic-layer query
 * contract. Keeping this in core gives Notebook, Ask, Apps, CLI, and MCP the
 * same filter/limit behavior instead of maintaining surface-specific rules.
 */
export function blockSemanticRuntimeBindings(
  block: BlockDeclNode,
  values: Record<string, unknown> = {},
): SemanticRuntimeParameterBindings {
  if (block.blockType !== 'semantic') return { filters: [] };

  const filters: SemanticRuntimeParameterBindings['filters'] = [];
  let limit: number | undefined;
  for (const definition of blockParameterDefinitions(block)) {
    const value = values[definition.name];
    if (value === undefined || value === null || value === '') continue;
    if (definition.binding?.kind === 'semantic_filter') {
      const rawValues = Array.isArray(value) ? value : [value];
      // Nothing selected in a multi-select means no filter, like an empty value above.
      if (rawValues.length === 0) continue;
      filters.push({
        dimension: definition.binding.field,
        operator: definition.binding.operator,
        values: rawValues.map((item) => String(item)),
      });
    } else if (definition.binding?.kind === 'limit') {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.floor(parsed);
    }
  }
  return { filters, ...(limit !== undefined ? { limit } : {}) };
}

export function evaluateBlockParameterExpression(node: ExpressionNode): unknown {
  switch (node.kind) {
    case NodeKind.StringLiteral:
    case NodeKind.NumberLiteral:
    case NodeKind.BooleanLiteral:
      return node.value;
    case NodeKind.ArrayLiteral:
      return node.elements.map(evaluateBlockParameterExpression);
    case NodeKind.Identifier:
      return node.name;
    default:
      return undefined;
  }
}

export function inferBlockParameterType(value: unknown): BlockParamType {
  if (Array.isArray(value)) {
    const types = new Set(value.map((item) => typeof item));
    if (types.size === 1 && types.has('number')) return 'number[]';
    if (value.every((item) => isDateString(item))) return 'date[]';
    return 'string[]';
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (isDateString(value)) return 'date';
  return 'string';
}

function inferBinding(input: {
  entry: BlockParamEntry;
  interpolationNames: Set<string>;
  filterBinding?: string;
  blockType: BlockDeclNode['blockType'];
}): BlockParameterBinding | undefined {
  if (input.interpolationNames.has(input.entry.name)) return { kind: 'sql_value' };
  if (input.entry.name === 'top_n' || input.filterBinding?.toLowerCase() === 'limit') return { kind: 'limit' };
  if (input.blockType === 'semantic' && input.filterBinding) {
    return { kind: 'semantic_filter', field: input.filterBinding, operator: input.entry.name.endsWith('_set') ? 'in' : 'equals' };
  }
  return undefined;
}

function normalizePolicy(value: string): BlockParameterPolicy {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'static' || normalized === 'business' || normalized === 'derived' || normalized === 'optional' || normalized === 'ambiguous_review_required'
    ? normalized
    : 'dynamic';
}

function coerceParameterValue(value: unknown, type: BlockParamType): { ok: true; value: unknown } | { ok: false } {
  if (type.endsWith('[]')) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : null;
    if (!values) return { ok: false };
    const itemType = type.slice(0, -2) as Exclude<BlockParamType, `${string}[]`>;
    const coerced = values.map((item) => coerceParameterValue(item, itemType));
    return coerced.every((item) => item.ok) ? { ok: true, value: coerced.map((item) => item.value) } : { ok: false };
  }
  if (type === 'number') {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? { ok: true, value: number } : { ok: false };
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true') return { ok: true, value: true };
    if (value === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  if (type === 'date') return isDateString(value) ? { ok: true, value } : { ok: false };
  return typeof value === 'string' || typeof value === 'number' ? { ok: true, value: String(value) } : { ok: false };
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
