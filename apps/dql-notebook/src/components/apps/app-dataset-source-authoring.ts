import {
  datasetMeasures,
  datasetPhysicalFields,
  type DatasetDescriptor,
  type DatasetFieldRole,
  type DatasetMeasureAggregation,
  type DatasetMeasureField,
  type DatasetPhysicalField,
} from '@zlens/core/datasets/descriptor';
import { renderDatasetAggregateExpression } from '@zlens/core/datasets/aggregate-expression';
import type { AppBlockRecommendation, DatasetAuthoringChange } from '../../api/client';

/**
 * Browser-safe source-authoring projection. This is deliberately only a
 * candidate builder: the server reparses the expression, checks every field
 * against the current source hash, compiles the complete declaration, and
 * forces the source into review. A number-looking field never becomes an
 * additive measure because a browser rendered a suggestion.
 */
export interface DatasetCalculatedMeasureDraft {
  name: string;
  expression: string;
  aggregation: DatasetMeasureAggregation;
  additivity: 'additive' | 'semi_additive' | 'non_additive';
  format: 'number' | 'currency' | 'percent';
  currency?: string;
}

export interface DatasetCalculatedMeasureCandidate extends DatasetCalculatedMeasureDraft {
  id: string;
  label: string;
  role: 'calculated_measure';
  dependencies: string[];
  /** Candidate provenance is display-only and never execution authority. */
  evidence: string;
}

/**
 * The editable, source-owned portion of a block Dataset declaration. Physical
 * names, data types, and status remain anchored to the compiled output
 * contract; an author can propose their role and time metadata but cannot add
 * a browser-invented column to the declaration.
 */
export interface DatasetSourceDefinitionDraft {
  grain: {
    entities: string;
    keys: string;
    keyEvidence: string;
    description: string;
    timeGrain: string;
    timeBucketBy: string;
    aggregate: boolean;
  };
  fields: Array<{
    name: string;
    role: DatasetFieldRole;
    type: DatasetPhysicalField['type'];
    status: DatasetPhysicalField['status'];
    grains: string;
    primary: boolean;
    hierarchy?: string;
    level?: number;
  }>;
}

export interface DatasetSourceAuthoringModel {
  source: AppBlockRecommendation;
  descriptor: DatasetDescriptor;
  grain: {
    entities: string[];
    keys: string[];
    keyEvidence?: string;
    timeGrain?: string;
    timeBucketBy?: string;
    aggregate?: boolean;
  };
  physicalFields: DatasetPhysicalField[];
  measures: DatasetMeasureField[];
  candidates: DatasetCalculatedMeasureCandidate[];
}

/** Only block-backed Dataset declarations can be patched by DQL source authoring. */
export function datasetSourceAuthoringModel(source: AppBlockRecommendation): DatasetSourceAuthoringModel | undefined {
  const descriptor = source.capabilities?.dataset;
  if (!descriptor || descriptor.kind !== 'block' || !source.qualifiedIdentity || !source.sourceRevision || !source.path) return undefined;
  // A saved query's result fields are read, not authored: "Make row-level" writes a definition (design D1).
  if (descriptor.result) return undefined;
  const physicalFields = datasetPhysicalFields(descriptor);
  return {
    source,
    descriptor,
    grain: {
      entities: [...descriptor.grain.entityIds],
      keys: [...descriptor.grain.keyFields],
      keyEvidence: descriptor.grain.keyEvidence,
      timeGrain: descriptor.grain.timeGrain,
      timeBucketBy: descriptor.grain.timeBucketBy,
      aggregate: descriptor.grain.aggregate,
    },
    physicalFields,
    measures: datasetMeasures(descriptor),
    candidates: datasetCalculatedMeasureCandidates(descriptor),
  };
}

/**
 * Build reviewable candidates solely from exact approved physical members.
 * They make the common governed formulas discoverable, while retaining a
 * non-additive default until a source author explicitly declares otherwise
 * and the runtime later supplies current aggregate safety evidence.
 */
export function datasetCalculatedMeasureCandidates(descriptor: DatasetDescriptor): DatasetCalculatedMeasureCandidate[] {
  const physical = datasetPhysicalFields(descriptor)
    .filter((field) => field.status === 'approved' && field.type === 'number');
  const exact = (name: string) => physical.find((field) => field.name.toLowerCase() === name);
  const revenue = exact('daily_revenue') ?? exact('revenue') ?? exact('net_amount') ?? exact('amount');
  const margin = exact('daily_margin') ?? exact('margin_amount') ?? exact('margin');
  const orders = exact('daily_orders') ?? exact('order_count') ?? exact('orders');
  const currency = measureCurrency(descriptor, revenue?.name);
  const candidates: DatasetCalculatedMeasureCandidate[] = [];

  if (revenue && margin) {
    candidates.push({
      id: 'candidate:gross_margin',
      label: 'Gross margin',
      role: 'calculated_measure',
      name: uniqueCandidateName(descriptor, 'gross_margin'),
      expression: `SUM(${revenue.name}) - SUM(${margin.name})`,
      aggregation: 'sum',
      // The suggestion deliberately does not assert a rollup proof.
      additivity: 'non_additive',
      format: currency ? 'currency' : 'number',
      currency,
      dependencies: [revenue.name, margin.name],
      evidence: `Candidate from approved physical fields ${revenue.name} and ${margin.name}. Additivity remains subject to review and live aggregate proof.`,
    });
    candidates.push({
      id: 'candidate:margin_rate',
      label: 'Margin rate',
      role: 'calculated_measure',
      name: uniqueCandidateName(descriptor, 'margin_rate'),
      expression: `SUM(${margin.name}) / NULLIF(SUM(${revenue.name}), 0)`,
      aggregation: 'ratio',
      additivity: 'non_additive',
      format: 'percent',
      dependencies: [margin.name, revenue.name],
      evidence: `Ratio of approved aggregate components ${margin.name} and ${revenue.name}; stored as 0–1 and never summed from displayed rows.`,
    });
  }
  if (revenue && orders) {
    candidates.push({
      id: 'candidate:average_order_value',
      label: 'Average order value',
      role: 'calculated_measure',
      name: uniqueCandidateName(descriptor, 'average_order_value'),
      expression: `SUM(${revenue.name}) / NULLIF(SUM(${orders.name}), 0)`,
      aggregation: 'ratio',
      additivity: 'non_additive',
      format: currency ? 'currency' : 'number',
      currency,
      dependencies: [revenue.name, orders.name],
      evidence: `Ratio of approved aggregate components ${revenue.name} and ${orders.name}; any count-distinct rollup needs a current component-disjointness proof.`,
    });
  }
  return candidates;
}

/** Project an exact current descriptor into the editable source form. */
export function datasetSourceDefinitionDraft(descriptor: DatasetDescriptor): DatasetSourceDefinitionDraft {
  return {
    grain: {
      entities: descriptor.grain.entityIds.join(', '),
      keys: descriptor.grain.keyFields.join(', '),
      keyEvidence: descriptor.grain.keyEvidence ?? '',
      description: descriptor.grain.description ?? '',
      timeGrain: descriptor.grain.timeGrain ?? '',
      timeBucketBy: descriptor.grain.timeBucketBy ?? '',
      aggregate: descriptor.grain.aggregate === true,
    },
    fields: datasetPhysicalFields(descriptor).map((field) => ({
      name: field.name,
      role: field.role,
      type: field.type,
      status: field.status,
      grains: field.time?.grains.join(', ') ?? '',
      primary: field.time?.primary === true,
      ...(field.hierarchy?.id ? { hierarchy: field.hierarchy.id, level: field.hierarchy.level } : {}),
    })),
  };
}

/**
 * Create the sole accepted browser request shape. Complete field/measure lists
 * are sent so a reviewed patch can preserve source order-independent contract
 * semantics; the server resolves target identity and current source hash again.
 */
export function datasetAuthoringChangeForMeasure(
  source: AppBlockRecommendation,
  descriptor: DatasetDescriptor,
  draft: DatasetCalculatedMeasureDraft,
): DatasetAuthoringChange {
  return datasetAuthoringChangeForDefinition(
    source,
    descriptor,
    datasetSourceDefinitionDraft(descriptor),
    draft,
  );
}

/**
 * Build one complete, hash-bound source declaration patch. A formula is
 * optional so an author can review a changed field role or grain declaration
 * by itself. The server still reparses the full patch against current source
 * bytes and forces the source into review.
 */
export function datasetAuthoringChangeForDefinition(
  source: AppBlockRecommendation,
  descriptor: DatasetDescriptor,
  definition: DatasetSourceDefinitionDraft,
  formula?: DatasetCalculatedMeasureDraft,
): DatasetAuthoringChange {
  if (descriptor.kind !== 'block' || !source.qualifiedIdentity || !source.path || !source.sourceRevision) {
    throw new Error('Only data from a current saved query can be edited. Refresh the source catalog and try again.');
  }
  const grain = grainPatchFromDefinition(descriptor, definition);
  const fields = fieldPatchesFromDefinition(descriptor, definition);
  const existingMeasures = datasetMeasures(descriptor).map(descriptorMeasurePatch);
  const proposedMeasure = formula ? calculatedMeasurePatch(descriptor, formula) : undefined;
  const baseDefinition = datasetSourceDefinitionDraft(descriptor);
  const definitionChanged = JSON.stringify(normalizedDefinition(definition)) !== JSON.stringify(normalizedDefinition(baseDefinition));
  if (!definitionChanged && !proposedMeasure) {
    throw new Error('Change a field role, native grain declaration, or formula before creating a source proposal.');
  }
  return {
    targetQualifiedId: source.qualifiedIdentity,
    targetPath: source.path,
    expectedSourceHash: source.sourceRevision,
    patch: {
      grain,
      fields,
      measures: [
        ...existingMeasures,
        ...(proposedMeasure ? [proposedMeasure] : []),
      ],
    },
  };
}

function grainPatchFromDefinition(
  descriptor: DatasetDescriptor,
  definition: DatasetSourceDefinitionDraft,
): NonNullable<DatasetAuthoringChange['patch']['grain']> {
  const entities = splitDeclarationList(definition.grain.entities, 'Native grain entities');
  const keys = splitDeclarationList(definition.grain.keys, 'Native grain keys');
  const physical = new Set(datasetPhysicalFields(descriptor).map((field) => field.name.toLowerCase()));
  const missingKeys = keys.filter((key) => !physical.has(key.toLowerCase()));
  if (missingKeys.length > 0) {
    throw new Error(`Native grain keys must be current physical fields: ${missingKeys.join(', ')}.`);
  }
  const bucket = definition.grain.timeBucketBy.trim();
  if (bucket) {
    const field = definition.fields.find((candidate) => candidate.name.toLowerCase() === bucket.toLowerCase());
    if (!field || field.role !== 'time' || (field.type !== 'date' && field.type !== 'timestamp')) {
      throw new Error('Time bucket must name a current date or timestamp field with the time role.');
    }
  }
  return {
    entities,
    keys,
    ...(definition.grain.keyEvidence.trim() ? { keyEvidence: definition.grain.keyEvidence.trim() } : {}),
    ...(definition.grain.description.trim() ? { description: definition.grain.description.trim() } : {}),
    ...(definition.grain.timeGrain.trim() ? { timeGrain: definition.grain.timeGrain.trim() } : {}),
    ...(bucket ? { timeBucketBy: bucket } : {}),
    ...(definition.grain.aggregate ? { aggregate: true } : {}),
  };
}

function fieldPatchesFromDefinition(
  descriptor: DatasetDescriptor,
  definition: DatasetSourceDefinitionDraft,
): Array<Record<string, unknown>> {
  const expected = datasetPhysicalFields(descriptor);
  if (definition.fields.length !== expected.length) {
    throw new Error('Physical fields are compiled from this source. Refresh the catalog instead of adding or removing a field here.');
  }
  const expectedByName = new Map(expected.map((field) => [field.name.toLowerCase(), field]));
  const names = new Set<string>();
  return definition.fields.map((draft) => {
    const key = draft.name.trim().toLowerCase();
    const original = expectedByName.get(key);
    if (!original || names.has(key) || draft.type !== original.type || draft.status !== original.status) {
      throw new Error('Physical field names, types, and approval status come from the compiled source and cannot be changed here.');
    }
    names.add(key);
    const grains = draft.grains.trim() ? splitDeclarationList(draft.grains, `${draft.name} time grains`) : [];
    if (grains.length > 0 && (draft.role !== 'time' || (draft.type !== 'date' && draft.type !== 'timestamp'))) {
      throw new Error(`Time grains for ${draft.name} require a date or timestamp field with the time role.`);
    }
    if (draft.primary && grains.length === 0) {
      throw new Error(`${draft.name} needs at least one declared time grain before it can be the primary time field.`);
    }
    return {
      name: original.name,
      role: draft.role,
      ...(grains.length ? { grains } : {}),
      ...(draft.primary ? { primary: true } : {}),
      ...(original.hierarchy?.id ? { hierarchy: original.hierarchy.id, level: original.hierarchy.level } : {}),
    };
  });
}

function calculatedMeasurePatch(
  descriptor: DatasetDescriptor,
  draft: DatasetCalculatedMeasureDraft,
): Record<string, unknown> | undefined {
  const name = draft.name.trim();
  const expression = draft.expression.trim();
  if (!name && !expression) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Formula names must be DQL identifiers.');
  if (!expression) throw new Error('Enter an aggregate formula before creating a proposal.');
  const measureNames = new Set(datasetMeasures(descriptor).map((measure) => measure.name.toLowerCase()));
  if (measureNames.has(name.toLowerCase())) throw new Error(`A measure named ${name} already exists in this data.`);
  return {
    name,
    aggregation: draft.aggregation,
    expression,
    additive: draft.additivity,
    entityAdditive: draft.additivity,
    allowedAggs: [draft.aggregation],
    format: draft.format,
    ...(draft.currency && draft.format === 'currency' ? { currency: draft.currency } : {}),
    status: 'approved' as const,
  };
}

function splitDeclarationList(value: string, label: string): string[] {
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || values.length > 32) throw new Error(`${label} must contain 1–32 comma-separated identifiers.`);
  if (new Set(values.map((item) => item.toLowerCase())).size !== values.length) {
    throw new Error(`${label} cannot contain duplicates.`);
  }
  return values;
}

function normalizedDefinition(value: DatasetSourceDefinitionDraft): DatasetSourceDefinitionDraft {
  return {
    grain: {
      entities: normalizedList(value.grain.entities),
      keys: normalizedList(value.grain.keys),
      keyEvidence: value.grain.keyEvidence.trim(),
      description: value.grain.description.trim(),
      timeGrain: value.grain.timeGrain.trim(),
      timeBucketBy: value.grain.timeBucketBy.trim(),
      aggregate: value.grain.aggregate,
    },
    fields: value.fields.map((field) => ({
      ...field,
      name: field.name.trim(),
      grains: normalizedList(field.grains),
      hierarchy: field.hierarchy?.trim(),
    })),
  };
}

function normalizedList(value: string): string {
  return value.split(',').map((item) => item.trim()).filter(Boolean).join(',');
}

function descriptorMeasurePatch(measure: DatasetMeasureField): Record<string, unknown> {
  return {
    name: measure.name,
    aggregation: measure.aggregation,
    ...(measure.from ? { from: measure.from } : {}),
    ...(measure.numerator ? { numerator: measure.numerator } : {}),
    ...(measure.denominator ? { denominator: measure.denominator } : {}),
    ...(measure.expression ? {
      expression: renderDatasetAggregateExpression(measure.expression, { physicalField: (field) => field }),
    } : {}),
    ...(measure.timeBucketBy ? { timeBucketBy: measure.timeBucketBy } : {}),
    additive: measure.additivity.time,
    entityAdditive: measure.additivity.entities,
    allowedAggs: [...measure.allowedAggs],
    ...(measure.format?.kind ? { format: measure.format.kind } : {}),
    ...(measure.format?.currency ? { currency: measure.format.currency } : {}),
    status: measure.status,
  };
}

function uniqueCandidateName(descriptor: DatasetDescriptor, preferred: string): string {
  const names = new Set(datasetMeasures(descriptor).map((measure) => measure.name.toLowerCase()));
  if (!names.has(preferred.toLowerCase())) return preferred;
  let index = 2;
  while (names.has(`${preferred}_${index}`.toLowerCase())) index += 1;
  return `${preferred}_${index}`;
}

function measureCurrency(descriptor: DatasetDescriptor, physicalName?: string): string | undefined {
  if (!physicalName) return undefined;
  return datasetMeasures(descriptor).find((measure) => measure.from?.toLowerCase() === physicalName.toLowerCase()
    && measure.format?.kind === 'currency')?.format?.currency;
}
