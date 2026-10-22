export {
  datasetField,
  datasetMeasureField,
  datasetMeasures,
  datasetPhysicalField,
  datasetPhysicalFields,
  isSavedQueryResultDataset,
  normalizeDatasetDescriptor,
} from './descriptor.js';
export type {
  DatasetAdditivity,
  DatasetContractRef,
  DatasetDescriptor,
  DatasetExecutionRoute,
  DatasetField,
  DatasetFieldRole,
  DatasetFieldStatus,
  DatasetFieldType,
  DatasetGrain,
  DatasetJoin,
  DatasetKind,
  DatasetLifecycle,
  DatasetMeasureAggregation,
  DatasetMeasureField,
  DatasetOperation,
  DatasetPhysicalField,
  DatasetResultOrigin,
  DatasetSourceBinding,
  DatasetTrust,
} from './descriptor.js';

export {
  canonicalDatasetAggregateExpression,
  inferredDatasetExpressionAggregation,
  isDatasetAggregateExpression,
  renderDatasetAggregateExpression,
  validateDatasetAggregateExpression,
} from './aggregate-expression.js';
export type {
  DatasetAggregateExpressionRenderOptions,
  DatasetAggregateExpressionV1,
  DatasetAggregateExpressionValidation,
  DatasetAggregateFunction,
} from './aggregate-expression.js';

export {
  datasetProofFingerprint,
  isDatasetGrainProof,
  validateDatasetGrainProof,
} from './proof.js';
export type {
  DatasetGrainProofV1,
  DatasetGrainProofValidation,
  DatasetGrainProofValidationInput,
} from './proof.js';

export {
  datasetAggregateComponentProofCovers,
  datasetAggregateComponentRequirements,
} from './component-proof.js';

export {
  normalizeDatasetCacheDeliveryReceipt,
  normalizeDatasetTileProvenance,
  normalizeEquivalenceProof,
  normalizeSemanticTileConversionProvenance,
} from './provenance.js';
export type {
  DatasetCacheDeliveryReceiptV1,
  DatasetTileProvenanceV1,
  EquivalenceProofV1,
  SemanticTileConversionProvenanceV1,
} from './provenance.js';
export type {
  DatasetAggregateComponentBindingV1,
  DatasetAggregateComponentProofStatus,
  DatasetAggregateComponentProofV1,
  DatasetAggregateComponentV1,
  DatasetAggregateComponentRequirement,
  DatasetAggregateComponentRequirementCode,
  DatasetAggregateComponentRequirementDiagnostic,
  DatasetAggregateComponentRequirements,
} from './component-proof.js';
export {
  applyTableDuplicateChoices,
  applyTableProfile,
  proposeTableDataset,
  renderTableDatasetBlock,
  tableColumnKind,
  tableDatasetCheckSentences,
  tableDatasetDeclaration,
  tableProfileColumns,
  singularWords,
  wordsFor,
} from './table-draft.js';
export {
  adoptDatasetJoins,
  bareRelation,
  datasetFieldForFilter,
  datasetJoinReceiptSentence,
  datasetJoinsTrust,
  datasetJoinsUsed,
  datasetRelatedFieldsUsed,
  discoverDatasetJoins,
  withoutSupersededEdges,
  relatedFieldParts,
  relatedFieldWords,
  tileQueryFieldNames,
  withDatasetJoins,
  withoutDatasetJoins,
} from './related-fields.js';
export type { DiscoveredDatasetJoins, RelatedRelationshipEdge } from './related-fields.js';
export type { TableColumnInput, TableColumnKind, TableDatasetDuplicate, TableDatasetField, TableDatasetHiddenColumn, TableDatasetMeasure, TableDatasetProposal, TableDuplicateChoice, TableProfile } from './table-draft.js';
export {
  NON_ADDITIVE_REASON,
  SAVED_QUERY_ROW_COUNT,
  isNonAdditiveColumnName,
  savedQueryColumnKind,
  savedQueryGroupByFromOutputs,
  savedQueryResultDescriptor,
  savedQueryResultFields,
  savedQueryResultRollup,
} from './result-fields.js';
export type { SavedQueryResultColumn, SavedQueryRollupCheck } from './result-fields.js';
