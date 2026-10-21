export {
  DATASET_PROOF_RELATIVE_PATH,
  LOCAL_DATASET_PROOF_RELATIVE_PATH,
  datasetDescriptorFromSemanticMetrics,
  datasetDescriptorFromSemanticMetric,
  datasetDescriptorFromManifestBlock,
  datasetBlockProofMaterial,
  datasetBindingAuthorityForManifestBlock,
  datasetProofScope,
  loadDatasetGrainProofs,
} from './registry.js';
export type {
  DatasetBindingAuthority,
  DatasetBlockProofMaterial,
  DatasetCatalogDescriptorResult,
  DatasetProofState,
  SemanticDatasetFieldProjection,
  SemanticDatasetMeasureProjection,
  SemanticMetricsDatasetProjectionInput,
  SemanticMetricDatasetProjectionInput,
} from './registry.js';

export {
  buildDatasetComparisonPlan,
  executeDatasetComparisonPlan,
} from './period-comparison.js';
export type {
  DatasetComparisonPlanResult,
} from './period-comparison.js';

export {
  planDriverQueries,
  foldDriverAnalysis,
  driverTotalTileId,
  driverDimensionTileId,
  isDriverExecutionTileId,
  DRIVER_MEASURE_ALIAS,
  DRIVER_MEMBER_ALIAS,
  DRIVER_MEMBERS_SHOWN,
} from './driver-analysis.js';
export type {
  DriverAnalysisV1,
  DriverDimensionV1,
  DriverMemberV1,
  DriverQueryPlan,
  DriverQueryPlanResult,
} from './driver-analysis.js';

export {
  SAVED_QUERY_RESULT_COLUMNS_RELATIVE_PATH,
  isPlainSavedQueryBlock,
  loadSavedQueryResultColumns,
  recordSavedQueryResultColumns,
  savedQueryResultDescriptorFromManifestBlock,
} from './result-columns.js';
export type { SavedQueryResultColumnsEntry } from './result-columns.js';
