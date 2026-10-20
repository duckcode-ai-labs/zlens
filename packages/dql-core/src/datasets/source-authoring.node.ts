import { createHash } from 'node:crypto';
import { NodeKind, type BlockDeclNode } from '../ast/index.js';
import { formatProgram } from '../formatter/formatter.js';
import { validateDatasetBlockSource } from '../manifest/builder.js';
import type {
  ManifestDatasetField,
  ManifestDatasetGrain,
  ManifestDatasetMeasure,
} from '../manifest/types.js';
import { parse } from '../parser/parser.js';

/** A bounded Dataset-only source patch. SQL and lifecycle changes are excluded. */
export interface DatasetDeclarationPatch {
  grain?: ManifestDatasetGrain;
  fields?: ManifestDatasetField[];
  measures?: ManifestDatasetMeasure[];
}

export interface DatasetDeclarationPatchResult {
  beforeFingerprint: string;
  afterFingerprint: string;
  after: string;
  blockName: string;
  /** A material Dataset declaration always enters the existing review lane. */
  lifecycle: 'review';
  diagnostics: Array<{ code: string; message: string }>;
}

export class DatasetDeclarationPatchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DatasetDeclarationPatchError';
  }
}

/**
 * Apply a typed Dataset patch in memory, then format, reparse, and validate
 * it through the manifest Dataset contract. The caller owns target identity
 * and current-source hash checks; this helper never reads or writes files.
 */
export function prepareDatasetDeclarationPatch(input: {
  source: string;
  filePath: string;
  blockName: string;
  patch: DatasetDeclarationPatch;
}): DatasetDeclarationPatchResult {
  if (!hasPatch(input.patch)) {
    throw new DatasetDeclarationPatchError('DATASET_CHANGE_EMPTY', 'Choose a Dataset grain, field, or measure change before creating a proposal.');
  }
  const program = parse(input.source, input.filePath);
  const matches = program.statements.filter((statement): statement is BlockDeclNode =>
    statement.kind === NodeKind.BlockDecl && statement.name === input.blockName,
  );
  if (matches.length !== 1) {
    throw new DatasetDeclarationPatchError(
      matches.length === 0 ? 'DATASET_SOURCE_TARGET_NOT_FOUND' : 'DATASET_SOURCE_TARGET_AMBIGUOUS',
      matches.length === 0
        ? `Dataset block ${input.blockName} no longer resolves in ${input.filePath}.`
        : `Dataset block ${input.blockName} is ambiguous in ${input.filePath}.`,
    );
  }
  const target = matches[0]!;
  // The parsed declaration is the only physical-field inventory that may be
  // edited.  A browser proposal is intentionally an overlay: it may change a
  // field's role or time/hierarchy metadata, but can never manufacture an
  // output column, remove one, retype it, or change its reviewed status.
  // Keeping this check beside the source reparse also protects non-HTTP
  // callers of this Node-only helper.
  const patchedFields = input.patch.fields
    ? overlayCanonicalDatasetFields(target.datasetFields, input.patch.fields)
    : undefined;
  const nextTarget: BlockDeclNode = {
    ...target,
    ...(input.patch.grain ? { datasetGrain: cloneGrain(input.patch.grain) } : {}),
    ...(patchedFields ? { datasetFields: patchedFields } : {}),
    ...(input.patch.measures ? { datasetMeasures: input.patch.measures.map(cloneMeasure) } : {}),
    // A source definition can gain a reviewed field/measure without being
    // certified. Existing certified state is intentionally never retained by
    // a material proposal acceptance.
    status: 'review',
  };
  const nextProgram = {
    ...program,
    statements: program.statements.map((statement) => statement === target ? nextTarget : statement),
  };
  const after = formatProgram(nextProgram);
  // Formatting is part of the durable source contract. Reparse the exact
  // proposed bytes rather than trusting the mutable in-memory node.
  parse(after, input.filePath);
  const validation = validateDatasetBlockSource(after, input.filePath);
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new DatasetDeclarationPatchError(
      'DATASET_CHANGE_INVALID',
      errors.map((diagnostic) => diagnostic.message).join(' '),
    );
  }
  const proposed = validation.blocks.filter((block) => block.name === input.blockName);
  if (proposed.length !== 1 || proposed[0]!.status !== 'review') {
    throw new DatasetDeclarationPatchError('DATASET_CHANGE_COMPILE_FAILED', 'The proposed Dataset declaration did not compile to one review-required block.');
  }
  return {
    beforeFingerprint: fingerprint(input.source),
    afterFingerprint: fingerprint(after),
    after,
    blockName: input.blockName,
    lifecycle: 'review',
    diagnostics: validation.diagnostics.map((diagnostic) => ({ code: diagnostic.kind, message: diagnostic.message })),
  };
}

/**
 * "Add fields" (design D1): give a saved query block (one without a Dataset
 * definition) its first grain, fields and measures, in memory. The block
 * keeps its name, query and every other property; only the Dataset
 * declarations and its lifecycle status change. The caller decides the
 * status (a certified block goes back to review until a certification check
 * passes) and owns file reads, writes and revision checks.
 */
export function addDatasetDefinitionToBlockSource(input: {
  source: string;
  filePath: string;
  blockName: string;
  grain: ManifestDatasetGrain;
  fields: ManifestDatasetField[];
  measures: ManifestDatasetMeasure[];
  status: 'draft' | 'review';
}): { after: string; beforeFingerprint: string; afterFingerprint: string } {
  const program = parse(input.source, input.filePath);
  const matches = program.statements.filter((statement): statement is BlockDeclNode =>
    statement.kind === NodeKind.BlockDecl && statement.name === input.blockName,
  );
  if (matches.length !== 1) {
    throw new DatasetDeclarationPatchError(
      matches.length === 0 ? 'DATASET_SOURCE_TARGET_NOT_FOUND' : 'DATASET_SOURCE_TARGET_AMBIGUOUS',
      matches.length === 0
        ? `Saved query ${input.blockName} no longer resolves in ${input.filePath}.`
        : `Saved query ${input.blockName} is ambiguous in ${input.filePath}.`,
    );
  }
  const target = matches[0]!;
  if (target.datasetGrain || target.datasetFields?.length || target.datasetMeasures?.length) {
    throw new DatasetDeclarationPatchError('SAVED_QUERY_ALREADY_DATASET', `${input.blockName} already has fields.`);
  }
  if (!input.fields.length || !input.measures.length) {
    throw new DatasetDeclarationPatchError('DATASET_CHANGE_EMPTY', 'Keep at least one field and one number before adding fields.');
  }
  const nextTarget: BlockDeclNode = {
    ...target,
    datasetGrain: cloneGrain(input.grain),
    datasetFields: input.fields.map(cloneField),
    datasetMeasures: input.measures.map(cloneMeasure),
    status: input.status,
  };
  const after = formatProgram({
    ...program,
    statements: program.statements.map((statement) => statement === target ? nextTarget : statement),
  });
  parse(after, input.filePath);
  const validation = validateDatasetBlockSource(after, input.filePath);
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new DatasetDeclarationPatchError('DATASET_CHANGE_INVALID', errors.map((diagnostic) => diagnostic.message).join(' '));
  }
  const proposed = validation.blocks.filter((block) => block.name === input.blockName);
  if (proposed.length !== 1 || !proposed[0]!.datasetGrain) {
    throw new DatasetDeclarationPatchError('DATASET_CHANGE_COMPILE_FAILED', 'The new fields did not compile to one Dataset block.');
  }
  return { after, beforeFingerprint: fingerprint(input.source), afterFingerprint: fingerprint(after) };
}

function hasPatch(patch: DatasetDeclarationPatch): boolean {
  return patch.grain !== undefined || patch.fields !== undefined || patch.measures !== undefined;
}

function cloneGrain(value: ManifestDatasetGrain): BlockDeclNode['datasetGrain'] {
  return {
    entities: [...value.entities],
    keys: [...value.keys],
    keyEvidence: value.keyEvidence,
    description: value.description,
    timeGrain: value.timeGrain,
    timeBucketBy: value.timeBucketBy,
    aggregate: value.aggregate,
  };
}

function cloneField(value: ManifestDatasetField): NonNullable<BlockDeclNode['datasetFields']>[number] {
  return {
    name: value.name,
    role: value.role,
    type: value.type,
    grains: value.grains ? [...value.grains] : undefined,
    primary: value.primary,
    hierarchy: value.hierarchy,
    level: value.level,
    status: value.status,
  };
}

/**
 * Apply a full physical-field form only when it names exactly the current
 * source inventory.  `status` defaults to approved in DQL, so compare that
 * effective value while preserving the source's authored optional spelling in
 * the resulting declaration.
 */
function overlayCanonicalDatasetFields(
  canonicalFields: BlockDeclNode['datasetFields'],
  proposedFields: ManifestDatasetField[],
): NonNullable<BlockDeclNode['datasetFields']> {
  if (!canonicalFields?.length) {
    throw new DatasetDeclarationPatchError(
      'DATASET_FIELD_INVENTORY_REQUIRED',
      'This Dataset has no authoritative physical-field inventory. Refresh or repair the source before authoring field roles.',
    );
  }
  const canonicalByName = new Map<string, NonNullable<BlockDeclNode['datasetFields']>[number]>();
  for (const field of canonicalFields) {
    const name = field.name?.trim();
    if (!name || !field.type || canonicalByName.has(name.toLowerCase())) {
      throw new DatasetDeclarationPatchError(
        'DATASET_FIELD_INVENTORY_REQUIRED',
        'This Dataset has an incomplete authoritative physical-field inventory. Refresh or repair the source before authoring field roles.',
      );
    }
    canonicalByName.set(name.toLowerCase(), field);
  }
  if (proposedFields.length !== canonicalFields.length) {
    throw new DatasetDeclarationPatchError(
      'DATASET_FIELD_INVENTORY_MISMATCH',
      'A field-role change must include every current physical field exactly once. Refresh the source catalog instead of adding or removing fields here.',
    );
  }
  const proposedByName = new Map<string, ManifestDatasetField>();
  for (const field of proposedFields) {
    const name = field.name?.trim();
    const canonical = name ? canonicalByName.get(name.toLowerCase()) : undefined;
    if (!name || !canonical || canonical.name !== name || proposedByName.has(name.toLowerCase())) {
      throw new DatasetDeclarationPatchError(
        'DATASET_FIELD_INVENTORY_MISMATCH',
        'Field-role changes may only reference the exact physical fields currently compiled from this source.',
      );
    }
    if (field.type !== undefined && field.type !== canonical.type) {
      throw new DatasetDeclarationPatchError(
        'DATASET_FIELD_TYPE_IMMUTABLE',
        `Physical field ${canonical.name} has type ${canonical.type}; changing a Dataset field type requires a source schema change outside this authoring form.`,
      );
    }
    const canonicalStatus = canonical.status ?? 'approved';
    const proposedStatus = field.status ?? 'approved';
    if (proposedStatus !== canonicalStatus) {
      throw new DatasetDeclarationPatchError(
        'DATASET_FIELD_STATUS_IMMUTABLE',
        `Physical field ${canonical.name} has ${canonicalStatus} status; changing field approval status requires its governed source review flow.`,
      );
    }
    proposedByName.set(name.toLowerCase(), field);
  }
  return canonicalFields.map((canonical) => {
    const proposed = proposedByName.get(canonical.name.toLowerCase());
    if (!proposed) {
      throw new DatasetDeclarationPatchError(
        'DATASET_FIELD_INVENTORY_MISMATCH',
        `Physical field ${canonical.name} is missing from this source-authoring proposal.`,
      );
    }
    return {
      name: canonical.name,
      role: proposed.role,
      type: canonical.type,
      ...(proposed.grains ? { grains: [...proposed.grains] } : {}),
      ...(proposed.primary ? { primary: true } : {}),
      ...(proposed.hierarchy ? { hierarchy: proposed.hierarchy } : {}),
      ...(proposed.level === undefined ? {} : { level: proposed.level }),
      ...(canonical.status === undefined ? {} : { status: canonical.status }),
    };
  });
}

function cloneMeasure(value: ManifestDatasetMeasure): NonNullable<BlockDeclNode['datasetMeasures']>[number] {
  return {
    name: value.name,
    aggregation: value.aggregation,
    from: value.from,
    numerator: value.numerator,
    denominator: value.denominator,
    expression: value.expression,
    timeBucketBy: value.timeBucketBy,
    additive: value.additive,
    entityAdditive: value.entityAdditive,
    allowedAggs: value.allowedAggs ? [...value.allowedAggs] : undefined,
    format: value.format,
    currency: value.currency,
    status: value.status,
  };
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
